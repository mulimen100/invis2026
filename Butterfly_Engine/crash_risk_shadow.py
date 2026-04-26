import json
import os
from contextlib import closing
from datetime import datetime, timezone

from crash_risk_engine import CrashRiskEngine


def _send_email_alert(subject: str, body: str) -> bool:
    try:
        recipient = os.environ.get("CRASH_RISK_RECIPIENT_EMAIL", "").strip()
        if recipient:
            os.environ["DRP_RECIPIENT_EMAIL"] = recipient
        from alerts import send_email

        return bool(send_email(subject, body))
    except Exception as e:
        print(f"❌ Crash risk email failed: {e}")
        return False


def _ensure_tables(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS crash_risk_history (
            id BIGSERIAL PRIMARY KEY,
            score DOUBLE PRECISION,
            flag TEXT,
            gated BOOLEAN,
            two_of_three_confirmed BOOLEAN,
            summary TEXT,
            raw_json JSONB,
            created_at TIMESTAMP DEFAULT NOW()
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS crash_risk_alert_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_flag TEXT,
            last_score DOUBLE PRECISION,
            last_alert_at TIMESTAMP,
            updated_at TIMESTAMP DEFAULT NOW()
        );
        """
    )
    cur.execute(
        """
        INSERT INTO crash_risk_alert_state (id, last_flag, last_score, last_alert_at, updated_at)
        VALUES (1, NULL, NULL, NULL, NOW())
        ON CONFLICT (id) DO NOTHING;
        """
    )


def _should_alert(
    curr_flag: str,
    prev_flag: str | None,
    prev2_flag: str | None,
    gated: bool,
    two_of_three: bool,
) -> tuple[bool, str]:
    # BLACK: immediate severe condition (but still require gate confirmation).
    if curr_flag == "BLACK" and gated:
        return True, f"BLACK with gated risk confirmation (prev={prev_flag or 'NONE'})"

    # RED: require one-day persistence + confirmations to reduce false alarms.
    if (
        curr_flag == "RED"
        and prev_flag in {"RED", "BLACK"}
        and gated
        and two_of_three
        and prev2_flag != "RED"
    ):
        return True, "RED persisted 2 days with gating + 2/3 confirmation"

    # Optional ORANGE alerts (default OFF)
    orange_enabled = os.environ.get("CRASH_RISK_ALERT_ORANGE", "0").strip() == "1"
    if orange_enabled and curr_flag == "ORANGE" and prev_flag not in {"ORANGE", "RED", "BLACK"}:
        return True, f"Orange transition: {prev_flag or 'NONE'} -> ORANGE"

    # Optional shock trigger
    shock = float(os.environ.get("CRASH_RISK_ALERT_SHOCK_POINTS", "15"))
    # shock comparison handled in caller with prev score
    return False, ""


def main():
    engine = CrashRiskEngine()
    data = engine.analyze()
    engine.save_status(data)

    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        print("⚠️ DATABASE_URL missing; shadow history/alerts skipped.")
        return

    curr_flag = str(data.get("flag", "YELLOW"))
    curr_score = float(data.get("score", 0.0))
    summary = str(data.get("summary", ""))
    curr_gated = bool(data.get("gated", False))
    curr_two_of_three = bool(data.get("two_of_three_confirmed", False))
    now_utc = datetime.now(timezone.utc)

    with closing(__import__("psycopg2").connect(db_url)) as conn:
        with conn.cursor() as cur:
            _ensure_tables(cur)
            cur.execute(
                """
                INSERT INTO crash_risk_history
                    (score, flag, gated, two_of_three_confirmed, summary, raw_json, created_at)
                VALUES
                    (%s, %s, %s, %s, %s, %s::jsonb, NOW())
                """,
                (
                    curr_score,
                    curr_flag,
                    bool(data.get("gated", False)),
                    bool(data.get("two_of_three_confirmed", False)),
                    summary,
                    json.dumps(data),
                ),
            )

            cur.execute("SELECT last_flag, last_score, last_alert_at FROM crash_risk_alert_state WHERE id=1")
            row = cur.fetchone() or (None, None, None)
            prev_flag, prev_score, last_alert_at = row

            cur.execute(
                "SELECT flag FROM crash_risk_history ORDER BY id DESC LIMIT 3"
            )
            flags = [r[0] for r in (cur.fetchall() or [])]
            # flags[0] is current just inserted row; flags[1] is previous day.
            prev_hist_flag = flags[1] if len(flags) > 1 else prev_flag
            prev2_hist_flag = flags[2] if len(flags) > 2 else None

            send, reason = _should_alert(
                curr_flag=curr_flag,
                prev_flag=prev_hist_flag,
                prev2_flag=prev2_hist_flag,
                gated=curr_gated,
                two_of_three=curr_two_of_three,
            )
            if not send:
                shock = float(os.environ.get("CRASH_RISK_ALERT_SHOCK_POINTS", "15"))
                if prev_score is not None and (curr_score - float(prev_score)) >= shock:
                    send = True
                    reason = f"Score jump >= {shock:.0f}: {prev_score:.1f} -> {curr_score:.1f}"

            # Simple cooldown
            cooldown_min = int(os.environ.get("CRASH_RISK_ALERT_COOLDOWN_MIN", "120"))
            if send and last_alert_at is not None:
                try:
                    delta_min = (now_utc.replace(tzinfo=None) - last_alert_at).total_seconds() / 60.0
                    if delta_min < cooldown_min:
                        send = False
                        reason = f"Cooldown active ({delta_min:.1f}m < {cooldown_min}m)"
                except Exception:
                    pass

            if send:
                subject = f"Crash Risk Alert: {curr_flag} ({curr_score:.1f})"
                body = (
                    f"Crash Early Warning\n\n"
                    f"Flag: {curr_flag}\n"
                    f"Score: {curr_score:.1f}\n"
                    f"Reason: {reason}\n"
                    f"Summary: {summary}\n"
                    f"Time (UTC): {now_utc.isoformat()}\n\n"
                    f"Suggested action: Review open risk and consider protective reduction if RED/BLACK.\n"
                )
                ok = _send_email_alert(subject, body)
                print(f"📧 Alert sent={ok} | {reason}")
                if ok:
                    cur.execute(
                        """
                        UPDATE crash_risk_alert_state
                        SET last_flag=%s, last_score=%s, last_alert_at=NOW(), updated_at=NOW()
                        WHERE id=1
                        """,
                        (curr_flag, curr_score),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE crash_risk_alert_state
                        SET last_flag=%s, last_score=%s, updated_at=NOW()
                        WHERE id=1
                        """,
                        (curr_flag, curr_score),
                    )
            else:
                cur.execute(
                    """
                    UPDATE crash_risk_alert_state
                    SET last_flag=%s, last_score=%s, updated_at=NOW()
                    WHERE id=1
                    """,
                    (curr_flag, curr_score),
                )
                print(f"ℹ️ No email alert | {reason or 'no trigger'}")

            conn.commit()

    print(
        f"[OK] Crash shadow updated | flag={curr_flag} score={curr_score:.1f} "
        f"gated={bool(data.get('gated', False))} two_of_three={bool(data.get('two_of_three_confirmed', False))}"
    )


if __name__ == "__main__":
    main()

