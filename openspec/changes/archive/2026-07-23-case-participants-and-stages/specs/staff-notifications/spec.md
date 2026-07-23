## MODIFIED Requirements

### Requirement: A fully-satisfied Case notifies Staff it is ready to complete

When the last outstanding Requirement on a Case becomes satisfied, a `case_ready` notification SHALL be created. "Outstanding" SHALL be computed across the whole Case — including Staff-internal unassigned Requirements — and SHALL exclude deleted and superseded Requirements. A Case is not ready while any counted Requirement remains unsatisfied, whichever Participant it belongs to and whether or not it is assigned.

#### Scenario: The final approval triggers a ready notification
- **GIVEN** a Case whose only remaining outstanding Requirement is Staff-internal (unassigned)
- **WHEN** that Requirement becomes satisfied
- **THEN** a `case_ready` notification is created

#### Scenario: A non-final approval does not
- **GIVEN** a Case where every assigned Requirement is satisfied but one unassigned Staff Requirement is not
- **WHEN** the last assigned Requirement becomes satisfied
- **THEN** no `case_ready` notification is created

#### Scenario: Superseded and deleted requirements do not count
- **GIVEN** a Case with a superseded Requirement and a deleted Requirement, and all live Requirements satisfied
- **WHEN** readiness is evaluated
- **THEN** the Case is considered ready and a `case_ready` notification is created

## ADDED Requirements

### Requirement: Per-Participant readiness is distinct from Case readiness

The system SHALL model `participant_ready` — every non-deleted, non-superseded Requirement assigned to a Participant is satisfied — as a distinct notion from `case_ready`. This change SHALL compute readiness correctly for both, but SHALL emit only `case_ready`; `participant_ready` is reserved for a later change.

#### Scenario: A participant finishing does not complete the case
- **GIVEN** a Case with Participants A and B, where all of A's assigned Requirements are satisfied but B's are not
- **WHEN** A's last assigned Requirement becomes satisfied
- **THEN** no `case_ready` notification is created, because the Case as a whole is not yet complete
