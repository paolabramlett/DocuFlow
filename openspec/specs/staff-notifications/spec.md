# staff-notifications Specification

## Purpose
TBD - created by archiving change reminders-and-notifications. Update Purpose after archive.
## Requirements
### Requirement: Staff are notified by event, not by digest

Staff notifications SHALL be generated in response to a Case state change that needs a person, not on a periodic schedule. The MVP SHALL NOT send Staff a periodic digest.

#### Scenario: A state change creates a notification
- **WHEN** a Case reaches a state that warrants Staff attention
- **THEN** a notification row is created at that moment, not on a later schedule

#### Scenario: No periodic digest is sent
- **WHEN** time passes without any qualifying Case state change
- **THEN** no Staff notification is generated

### Requirement: A document upload notifies Staff that a review is needed

When a Client uploads a Document, a notification SHALL be created for the owning Organization indicating a review is needed.

#### Scenario: Upload triggers a review-needed notification
- **WHEN** a Client uploads a Document to a Case
- **THEN** a `review_needed` notification is created for that Case's Organization

#### Scenario: A staff upload does not notify
- **WHEN** a Member uploads a Document themselves
- **THEN** no `review_needed` notification is created

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

### Requirement: Notifications are tenant-isolated and Staff-only

Staff notifications SHALL be readable only by Members of the owning Organization. Clients SHALL NOT read them, and cross-organization reads SHALL return nothing.

#### Scenario: A client cannot read staff notifications
- **WHEN** a Client with an active grant reads staff notifications
- **THEN** zero rows are returned

#### Scenario: Cross-organization notification reads return nothing
- **WHEN** a Member of one Organization reads notifications belonging to another
- **THEN** zero rows are returned

### Requirement: Notifications are attributable and carry no secrets

Each notification SHALL record the Case, the reason, and the time. It SHALL NOT store document contents, signed URLs, or credentials.

#### Scenario: A notification identifies its case and reason
- **WHEN** a notification is created
- **THEN** it records the Case id, a reason, and a timestamp

#### Scenario: A notification carries no document contents
- **WHEN** a review-needed notification is created for an uploaded Document
- **THEN** it references the Document by id and stores no file contents or URL

### Requirement: Per-Participant readiness is distinct from Case readiness

The system SHALL model `participant_ready` — every non-deleted, non-superseded Requirement assigned to a Participant is satisfied — as a distinct notion from `case_ready`. This change SHALL compute readiness correctly for both, but SHALL emit only `case_ready`; `participant_ready` is reserved for a later change.

#### Scenario: A participant finishing does not complete the case
- **GIVEN** a Case with Participants A and B, where all of A's assigned Requirements are satisfied but B's are not
- **WHEN** A's last assigned Requirement becomes satisfied
- **THEN** no `case_ready` notification is created, because the Case as a whole is not yet complete

