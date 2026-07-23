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

When the last outstanding requirement on a Case becomes satisfied, a notification SHALL be created indicating the Case is ready to complete.

#### Scenario: The final approval triggers a ready notification
- **GIVEN** a Case with one outstanding requirement remaining
- **WHEN** that requirement becomes satisfied
- **THEN** a `case_ready` notification is created

#### Scenario: A non-final approval does not
- **GIVEN** a Case with two outstanding requirements
- **WHEN** one becomes satisfied
- **THEN** no `case_ready` notification is created

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

