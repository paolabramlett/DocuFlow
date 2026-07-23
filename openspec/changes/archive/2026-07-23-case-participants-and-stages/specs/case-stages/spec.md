## ADDED Requirements

### Requirement: Stages are first-class ordered entities

Both Blueprints and Cases SHALL support an ordered set of Stages, modelled as real rows rather than a free-text column. A Stage SHALL belong to exactly one Blueprint or one Case within its Organization and carry a name and an explicit position.

#### Scenario: A blueprint defines ordered stages
- **WHEN** a Blueprint is given stages "Documents", "Payment", "Signature"
- **THEN** three ordered Stage rows exist for that Blueprint

#### Scenario: A case carries its own stages
- **WHEN** a Case is created
- **THEN** its Stages are Case-owned rows, independent of any Blueprint's

### Requirement: A Requirement may belong to a Stage

A Requirement MAY reference a Stage of its Case, or none. A Requirement without a Stage SHALL behave as belonging to the Case's default ordering.

#### Scenario: Requirement assigned to a stage
- **WHEN** a Requirement is placed in the "Documents" Stage of its Case
- **THEN** it is returned within that Stage, ordered by its position

#### Scenario: Requirement without a stage is still valid
- **WHEN** a Requirement is created with no Stage
- **THEN** it is accepted and ordered by position at the Case level

### Requirement: Cloning a Blueprint deep-copies stages and preserves mappings

Creating a Case from a Blueprint SHALL copy the Blueprint's Stages into new Case Stages and assign each cloned Requirement to the Case Stage corresponding to its Blueprint Stage. As with all cloning, later Blueprint edits SHALL NOT reach the Case.

#### Scenario: Stages are copied on clone
- **GIVEN** a Blueprint with three Stages and Requirements mapped across them
- **WHEN** a Case is created from it
- **THEN** the Case has three Stages and each Requirement sits in the Stage matching its Blueprint mapping

#### Scenario: Editing blueprint stages does not affect existing cases
- **GIVEN** a Case cloned from a Blueprint
- **WHEN** the Blueprint's Stages are renamed, reordered, or deleted
- **THEN** the Case's Stages and mappings are unchanged

### Requirement: A single default Stage is sufficient

A Case SHALL be usable with exactly one Stage. The domain SHALL support several Stages without a schema change, but a single default Stage SHALL require no special handling.

#### Scenario: One-stage case behaves like a flat list
- **GIVEN** a Case with a single Stage
- **WHEN** its Requirements are listed
- **THEN** they appear as one ordered list within that Stage

### Requirement: Stages are tenant-isolated

`blueprint_stages` and `case_stages` SHALL be readable only within their owning Organization. A Client SHALL see Case Stages only insofar as they contain Requirements assigned to that Client's Participant.

#### Scenario: Cross-organization stage read returns nothing
- **WHEN** a Member of one Organization reads Stages of another
- **THEN** zero rows are returned
