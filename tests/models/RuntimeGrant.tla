-------------------------- MODULE RuntimeGrant --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
Grants == {"a", "b"}
VARIABLES epoch, consentEpoch, issued, revoked, pending, delivered, badAdmission
vars == <<epoch, consentEpoch, issued, revoked, pending, delivered, badAdmission>>

\* Focused obligation, not a refinement proof. One DO commit is atomic;
\* HTTP delivery can be lost. Two grants distinguish grant-local revocation.
\* One global revocation and two code attempts suffice for the replay witness.
\* Token bytes, PKCE, expiry, D1 policy and library parsing are outside this model.
\* Safety only: no fairness or eventual network-response assumption.
Init == /\ epoch = 0
        /\ consentEpoch = [g \in Grants |-> 2]
        /\ issued = [g \in Grants |-> 0]
        /\ revoked = {}
        /\ pending = {}
        /\ delivered = {}
        /\ badAdmission = FALSE

Consent(g) == /\ consentEpoch[g] = 2
              /\ consentEpoch' = [consentEpoch EXCEPT ![g] = epoch]
              /\ UNCHANGED <<epoch, issued, revoked, pending, delivered, badAdmission>>

Exchange(g) == /\ consentEpoch[g] = epoch /\ g \notin revoked /\ issued[g] < 2
               /\ IF issued[g] = 0 \/ Fault = "code-replay"
                     THEN /\ issued' = [issued EXCEPT ![g] = @ + 1]
                          /\ pending' = pending \cup {g}
                          /\ UNCHANGED revoked
                     ELSE /\ revoked' = revoked \cup {g}
                          /\ UNCHANGED <<issued, pending>>
               /\ UNCHANGED <<epoch, consentEpoch, delivered, badAdmission>>

Deliver(g) == /\ g \in pending
              /\ pending' = pending \ {g}
              /\ delivered' = delivered \cup {g}
              /\ UNCHANGED <<epoch, consentEpoch, issued, revoked, badAdmission>>

Lose(g) == /\ g \in pending
           /\ pending' = pending \ {g}
           /\ UNCHANGED <<epoch, consentEpoch, issued, revoked, delivered, badAdmission>>

RevokeAll == /\ epoch = 0 /\ epoch' = 1
             /\ UNCHANGED <<consentEpoch, issued, revoked, pending, delivered, badAdmission>>

Admit(g) == /\ issued[g] > 0
            /\ LET valid == consentEpoch[g] = epoch /\ g \notin revoked
               IN badAdmission' = (badAdmission \/ (~valid /\ Fault = "stale-admit"))
            /\ UNCHANGED <<epoch, consentEpoch, issued, revoked, pending, delivered>>

Next == RevokeAll \/ \E g \in Grants : Consent(g) \/ Exchange(g) \/ Deliver(g) \/ Lose(g) \/ Admit(g)
Spec == Init /\ [][Next]_vars
CodeOnce == \A g \in Grants : issued[g] <= 1
NoUnauthorizedAdmission == ~badAdmission
=============================================================================
