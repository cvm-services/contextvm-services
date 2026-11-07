"""The state machine is the dashboard's only contract with the harness.
Tested because a wrong terminal state is an operational lie: `failed` when the
hold merely elapsed sends a human hunting a bug that does not exist, and
`outcome_unknown` collapsed into `failed` invites a duplicate purchase."""
import json, os, sys, tempfile

sys.path.insert(0, os.path.dirname(__file__))
os.environ["CVM_SESSION_STATE"] = ""
import venue_phone_test as v  # noqa: E402


def test_writes_atomic_payload():
    d = tempfile.mkdtemp()
    v.STATE_FILE = os.path.join(d, "state.json")
    v.set_state("awaiting_human", hold_seconds=30)
    got = json.load(open(v.STATE_FILE))
    assert got["state"] == "awaiting_human", got
    assert got["detail"]["hold_seconds"] == 30
    assert "updated_at" in got and got["updated_at"].endswith("Z")
    assert not os.path.exists(v.STATE_FILE + ".tmp"), "temp file must be renamed away"


def test_rejects_undeclared_state():
    d = tempfile.mkdtemp()
    v.STATE_FILE = os.path.join(d, "state.json")
    try:
        v.set_state("definitely-not-a-state")
    except ValueError:
        return
    raise AssertionError("an undeclared state must be refused, not written")


def test_abort_maps_to_expired_or_failed():
    d = tempfile.mkdtemp()
    v.STATE_FILE = os.path.join(d, "state.json")
    v.step("ABORT", code="captcha-not-passed")
    assert json.load(open(v.STATE_FILE))["state"] == "expired"
    v.step("ABORT", code="wrong-destination", country="DE")
    assert json.load(open(v.STATE_FILE))["state"] == "failed"
    assert "failed" in v.STATES and "outcome_unknown" in v.STATES


def test_no_state_file_is_not_fatal():
    v.STATE_FILE = ""
    v.set_state("completed")   # must be a no-op, never an exception


def test_find_venue_ref_reads_the_confirmation_page():
    class P:
        def inner_text(self, _sel):
            return "Bestellung erfolgreich!\nBestellnummer 4\nSumme 1,94 EUR"
    assert v._find_venue_ref(P()) == "4"


def test_completion_signal_finishes_confirmed():
    d = tempfile.mkdtemp()
    v.STATE_FILE = os.path.join(d, "state.json")
    sid = "s_test_signal_confirmed"
    path = f"/tmp/cvm-session-{sid}.complete"
    with open(path, "w") as f:
        json.dump({"outcome": "confirmed", "venue_ref": "TB-9"}, f)

    class B:
        closed = False
        def close(self):
            self.closed = True

    sig = v._completion_signal(sid)
    assert sig and sig["outcome"] == "confirmed"
    b = B()
    v._finish_from_signal(object(), b, sid, sig)
    got = json.load(open(v.STATE_FILE))
    assert got["state"] == "completed", got
    assert got["detail"]["venue_ref"] == "TB-9"
    assert b.closed, "the browser must be closed on a human verdict"
    assert not os.path.exists(path), "the signal must be consumed"


def test_completion_signal_unknown_is_terminal():
    d = tempfile.mkdtemp()
    v.STATE_FILE = os.path.join(d, "state.json")
    sid = "s_test_signal_unknown"
    path = f"/tmp/cvm-session-{sid}.complete"
    with open(path, "w") as f:
        json.dump({"outcome": "unknown"}, f)

    class B:
        def close(self):
            pass

    sig = v._completion_signal(sid)
    v._finish_from_signal(object(), B(), sid, sig)
    got = json.load(open(v.STATE_FILE))
    assert got["state"] == "outcome_unknown", got
    assert not os.path.exists(path)


def test_completion_signal_absent_is_ignored():
    assert v._completion_signal("s_definitely_absent") is None


def test_assisted_defaults_leave_card_and_phone_to_humans():
    old_env = dict(os.environ)
    old_argv = list(sys.argv)
    try:
        os.environ.pop("CVM_CARD_SOURCE", None)
        os.environ.pop("CVM_PHONE_AUTO", None)
        sys.argv = ["venue_phone_test.py"]
        args = v._parse_args()
        assert args.card_source == "manual"
        assert args.phone_auto == 0
        assert args.phone_mode == "jmp"  # old automation remains available
        assert v._load_card(args) is None
    finally:
        os.environ.clear(); os.environ.update(old_env)
        sys.argv = old_argv


def test_card_handoff_is_consumed_and_deleted():
    sid = "s_card_delete"
    path = f"/tmp/cvm-session-{sid}.card.json"
    with open(path, "w") as f:
        json.dump({"source": "manual",
                   "card": {"pan": "4111111111111111", "exp": "12/30", "cvc": "123"}}, f)
    args = type("Args", (), {"session_id": sid})()
    card = v._card_from_handoff(args)
    assert card == {"pan": "4111111111111111", "exp": "12/30", "cvc": "123"}
    assert not os.path.exists(path)


def test_phone_automation_remains_an_explicit_opt_in():
    old_argv = list(sys.argv)
    try:
        sys.argv = ["venue_phone_test.py", "--phone-auto", "1"]
        args = v._parse_args()
        assert args.phone_auto == 1
        assert hasattr(args, "phone_country")
        assert hasattr(args, "phone_mode")
    finally:
        sys.argv = old_argv


for name, fn in sorted(globals().items()):
    if name.startswith("test_"):
        fn()
        print(f"ok   {name}")
print("all state-machine tests passed")
