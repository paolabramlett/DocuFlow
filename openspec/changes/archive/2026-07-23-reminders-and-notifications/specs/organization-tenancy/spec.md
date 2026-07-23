## ADDED Requirements

### Requirement: Organizations carry reminder cadence configuration

An Organization SHALL carry reminder cadence policy alongside its existing configuration: the delay before the first reminder, the interval between reminders, and the maximum number of reminders. These SHALL be constrained to sane ranges and SHALL default without requiring input during onboarding.

These fields are configuration, not access paths. They SHALL NOT change the tenant isolation model or grant any new read or write reach across Organizations.

#### Scenario: Cadence columns default on creation
- **WHEN** an Organization is created
- **THEN** it carries a default first-delay, interval, and maximum reminder count

#### Scenario: Cadence values are range-constrained
- **WHEN** a cadence value outside its allowed range is written
- **THEN** the database rejects it with a check constraint violation

#### Scenario: Cadence configuration does not widen access
- **GIVEN** two Organizations
- **WHEN** one reads the other's cadence configuration
- **THEN** zero rows are returned, exactly as for any other field
