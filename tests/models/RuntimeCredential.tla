------------------------ MODULE RuntimeCredential ------------------------
EXTENDS Integers, FiniteSets
CONSTANT Fault
VARIABLES revision, binding, phase, retired, stored, floor,
          writer, admitted, badCommit, badRead
vars == <<revision, binding, phase, retired, stored, floor,
          writer, admitted, badCommit, badRead>>

\* Focused obligation for #8's separate D1 / encrypted-owner effects.
\* One old authority (0), one replacement (1), and one later retirement (2).
\* D1 commits and secret-owner writes are individually atomic, never one txn.
\* Lost responses/crashes may leave any phase unchanged indefinitely. No
\* fairness or eventual-cleanup claim. SQL actor checks, access expiry, crypto,
\* time, multiple installations and a second replacement are test obligations.
Init == /\ revision = 0 /\ binding = 0 /\ phase = "ready"
        /\ retired = FALSE /\ stored = {0} /\ floor = 0
        /\ writer = "idle" /\ admitted = -1
        /\ badCommit = FALSE /\ badRead = FALSE

Begin == /\ writer = "idle" /\ ~retired
         /\ revision' = 1 /\ phase' = "writing" /\ writer' = "pending"
         /\ UNCHANGED <<binding, retired, stored, floor, admitted, badCommit, badRead>>

Store == /\ writer = "pending"
         /\ stored' = IF floor <= 1 \/ Fault = "late-store" THEN stored \cup {1} ELSE stored
         /\ writer' = "stored"
         /\ UNCHANGED <<revision, binding, phase, retired, floor, admitted, badCommit, badRead>>

Commit == /\ writer = "stored" /\ 1 \in stored
          /\ ((revision = 1 /\ ~retired) \/ Fault = "stale-commit")
          /\ binding' = 1 /\ phase' = "cleaning" /\ writer' = "done"
          /\ badCommit' = (badCommit \/ retired \/ revision # 1)
          /\ UNCHANGED <<revision, retired, stored, floor, admitted, badRead>>

Retire == /\ ~retired /\ retired' = TRUE
          /\ revision' = 2 /\ binding' = -1 /\ phase' = "cleaning"
          /\ UNCHANGED <<stored, floor, writer, admitted, badCommit, badRead>>

Clean == /\ phase = "cleaning"
         /\ stored' = IF retired THEN {} ELSE stored \cap {binding}
         /\ floor' = revision /\ phase' = "ready"
         /\ UNCHANGED <<revision, binding, retired, writer, admitted, badCommit, badRead>>

Admit == /\ admitted = -1 /\ phase = "ready" /\ ~retired
         /\ admitted' = binding
         /\ UNCHANGED <<revision, binding, phase, retired, stored, floor, writer, badCommit, badRead>>

Read == /\ admitted # -1
        /\ LET selected == IF Fault = "latest-read" THEN binding ELSE admitted
           IN badRead' = (badRead \/ (selected \in stored /\ selected # admitted))
        /\ UNCHANGED <<revision, binding, phase, retired, stored, floor, writer, admitted, badCommit>>

Next == Begin \/ Store \/ Commit \/ Retire \/ Clean \/ Admit \/ Read
Spec == Init /\ [][Next]_vars
NoStaleCommit == ~badCommit
NoAuthoritySwap == ~badRead
CleanupStaysComplete == (retired /\ phase = "ready") => stored = {}
=============================================================================
