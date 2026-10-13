------------------------ MODULE RuntimeAdmission ------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES active, disabledOnce, accessRevision, installationRevision,
          grantRevoked, gate, phase, grantAccepted, badAdmission
vars == <<active, disabledOnce, accessRevision, installationRevision,
          grantRevoked, gate, phase, grantAccepted, badAdmission>>

\* Focused design obligation for SECURITY.md's D1/DO admission boundary.
\* One existing consent binds access/installation revision zero. A primary D1
\* snapshot is atomic; grant revocation is a separate DO commit. The DO gate
\* prevents that commit while the primary read is pending, not D1 mutations.
\* One disable/enable and one rebind preserve the stale-authority witnesses.
\* Network return can be lost; failure denies admission and releases the gate.
\* No fairness, liveness, SQL implementation, expiry, lease or performance proof.
Init == /\ active = TRUE /\ disabledOnce = FALSE
        /\ accessRevision = 0 /\ installationRevision = 0
        /\ grantRevoked = FALSE /\ gate = FALSE /\ phase = "idle"
        /\ grantAccepted = FALSE /\ badAdmission = FALSE

Begin == /\ phase = "idle"
         /\ phase' = "read"
         /\ gate' = (Fault # "ungated")
         /\ grantAccepted' = ~grantRevoked
         /\ UNCHANGED <<active, disabledOnce, accessRevision,
                        installationRevision, grantRevoked, badAdmission>>

Disable == /\ active /\ ~disabledOnce
           /\ active' = FALSE /\ disabledOnce' = TRUE
           /\ accessRevision' = IF Fault = "revival" THEN 0 ELSE 1
           /\ UNCHANGED <<installationRevision, grantRevoked, gate, phase,
                          grantAccepted, badAdmission>>

Enable == /\ ~active /\ active' = TRUE
          /\ UNCHANGED <<disabledOnce, accessRevision, installationRevision,
                         grantRevoked, gate, phase, grantAccepted, badAdmission>>

Rebind == /\ installationRevision = 0 /\ installationRevision' = 1
          /\ UNCHANGED <<active, disabledOnce, accessRevision, grantRevoked,
                         gate, phase, grantAccepted, badAdmission>>

Revoke == /\ ~gate /\ ~grantRevoked /\ grantRevoked' = TRUE
          /\ UNCHANGED <<active, disabledOnce, accessRevision,
                         installationRevision, gate, phase, grantAccepted, badAdmission>>

PrimaryRead == /\ phase = "read"
               /\ LET admitted == grantAccepted /\ active
                                  /\ accessRevision = 0 /\ installationRevision = 0
                  IN badAdmission' = (badAdmission \/
                     (admitted /\ (grantRevoked \/ disabledOnce \/ installationRevision # 0)))
               /\ phase' = "response" /\ gate' = FALSE
               /\ UNCHANGED <<active, disabledOnce, accessRevision,
                              installationRevision, grantRevoked, grantAccepted>>

Unavailable == /\ phase = "read" /\ phase' = "done" /\ gate' = FALSE
               /\ UNCHANGED <<active, disabledOnce, accessRevision,
                              installationRevision, grantRevoked, grantAccepted, badAdmission>>

\* Delivery and lost delivery have the same state projection: admission is
\* already decided. Neither replay nor undo of external work follows.
Finish == /\ phase = "response" /\ phase' = "done"
          /\ UNCHANGED <<active, disabledOnce, accessRevision, installationRevision,
                         grantRevoked, gate, grantAccepted, badAdmission>>

Next == Begin \/ Disable \/ Enable \/ Rebind \/ Revoke \/ PrimaryRead \/ Unavailable \/ Finish
Spec == Init /\ [][Next]_vars
NoStaleAdmission == ~badAdmission
=============================================================================
