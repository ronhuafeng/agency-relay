---------------------------- MODULE CreditFacts ----------------------------
EXTENDS Integers, FiniteSets
CONSTANT BrokenAdmission

\* Focused safety obligation: atomic durable admission and independent terminal
\* confirmation. Two competing attempts, another month, and another owner.
\* No liveness claim: provider completion or persistence may never arrive.
Users == {"u", "v"}
Periods == {"m1", "m2"}
Attempts == {"a", "b", "c", "d"}
Owner(a) == IF a = "d" THEN "v" ELSE "u"
Period(a) == IF a = "c" THEN "m2" ELSE "m1"
Scope(a) == <<Owner(a), Period(a)>>
Scopes == Users \X Periods
Opening(s) == IF s = <<"u", "m1">> THEN 1 ELSE 0
Cap(s) == Opening(s) + 1

VARIABLES consumed, receipts, terminal
vars == <<consumed, receipts, terminal>>
ChargedAt(s) == {a \in receipts : Scope(a) = s}

Init == /\ consumed = [s \in Scopes |-> Opening(s)]
        /\ receipts = {}
        /\ terminal = {}

Admit(a) == /\ a \notin receipts
            /\ consumed[Scope(a)] < Cap(Scope(a))
            /\ consumed' = [consumed EXCEPT ![Scope(a)] = @ + 1]
            /\ receipts' = IF BrokenAdmission THEN receipts ELSE receipts \cup {a}
            /\ UNCHANGED terminal

Confirm(a) == /\ a \in receipts
              /\ a \notin terminal
              /\ terminal' = terminal \cup {a}
              /\ UNCHANGED <<consumed, receipts>>

\* Denial, lost completion and duplicate terminal delivery may stutter.
Next == (\E a \in Attempts : Admit(a) \/ Confirm(a)) \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ consumed \in [Scopes -> Nat]
          /\ receipts \subseteq Attempts
          /\ terminal \subseteq receipts
Conservation == \A s \in Scopes : consumed[s] = Opening(s) + Cardinality(ChargedAt(s))
CapSafety == \A s \in Scopes : consumed[s] <= Cap(s)
=============================================================================
