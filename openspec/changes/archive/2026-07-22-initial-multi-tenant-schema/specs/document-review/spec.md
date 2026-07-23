## ADDED Requirements

### Requirement: Documents are stored in private, organization-scoped storage

Uploaded files SHALL be stored in non-public Supabase Storage buckets under a path prefixed by the owning `organization_id`. No bucket serving Documents SHALL be publicly readable.

#### Scenario: No public bucket
- **WHEN** storage configuration is inspected
- **THEN** every bucket holding Documents reports public access disabled

#### Scenario: Direct object URL is not readable
- **WHEN** an unauthenticated request is made to a Document's storage object path
- **THEN** the request is refused

#### Scenario: Storage path carries the tenant prefix
- **WHEN** a Document is uploaded for a Case in Organization A
- **THEN** its storage path begins with Organization A's identifier

### Requirement: Document access is granted only through short-lived signed URLs

Reads SHALL be served by signed URLs with a short expiry, issued only after policy evaluation confirms the caller's access to the owning Case.

#### Scenario: Signed URL issued to an authorized caller
- **GIVEN** a Member of the owning Organization, or a Client with an active grant on the Case
- **WHEN** the caller requests a Document
- **THEN** a signed URL with a short expiry is issued

#### Scenario: Signed URL is refused across tenants
- **WHEN** a Member of Organization A requests a signed URL for a Document owned by Organization B
- **THEN** the request is refused and no URL is issued

#### Scenario: Expired signed URL stops working
- **WHEN** a signed URL is used after its expiry
- **THEN** the storage request is refused

### Requirement: Clients may upload only to their granted Case with upload permission

A Document upload SHALL be accepted only when the caller holds an active grant on the target Requirement's Case with permission `upload`, or is a Member of the owning Organization.

#### Scenario: Client uploads to a granted requirement
- **GIVEN** a Client with an active grant and permission `upload`
- **WHEN** the Client uploads a file to a Requirement of that Case
- **THEN** the Document row is created and linked to that Requirement

#### Scenario: Client cannot upload to another case
- **WHEN** a Client attempts to upload to a Requirement belonging to a Case they hold no grant on
- **THEN** the write is denied by policy

#### Scenario: View-only client cannot upload
- **GIVEN** an active grant with permission `view`
- **WHEN** the Client attempts an upload
- **THEN** the write is denied by policy

### Requirement: Staff review Documents with an approve or reject decision

A Review SHALL record a decision of `approved` or `rejected`, the reviewing Member, and the time. A rejection SHALL be able to carry a reason visible to the Client.

#### Scenario: Approval satisfies the requirement
- **WHEN** Staff approves the Document on a Requirement
- **THEN** the Requirement is marked satisfied and further client upload to it is no longer requested

#### Scenario: Rejection reopens the requirement
- **WHEN** Staff rejects a Document with a reason
- **THEN** the Requirement returns to an outstanding state, the reason is visible to the Client, and a new upload is accepted

#### Scenario: Clients cannot review
- **WHEN** a Client attempts to insert a Review
- **THEN** the write is denied by policy

#### Scenario: Review history is preserved
- **GIVEN** a Document rejected once and then replaced and approved
- **WHEN** the Requirement's history is read by Staff
- **THEN** both the rejection and the approval remain retrievable

### Requirement: Document metadata is validated on upload

The system SHALL record file name, content type, and size, and SHALL enforce configured limits on accepted content types and maximum size.

#### Scenario: Oversized upload is refused
- **WHEN** an upload exceeds the configured maximum size
- **THEN** the upload is refused and no Document row is created

#### Scenario: Disallowed content type is refused
- **WHEN** an upload declares a content type outside the allowed set
- **THEN** the upload is refused and no Document row is created
