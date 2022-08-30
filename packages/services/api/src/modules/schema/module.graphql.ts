import { gql } from 'graphql-modules';

export default gql`
  extend type Mutation {
    """
    Requires API Token
    """
    schemaPublish(input: SchemaPublishInput!): SchemaPublishPayload!
    """
    Requires API Token
    """
    schemaDelete(input: SchemaDeleteInput!): SchemaDeleteResult!
    """
    Requires API Token
    """
    schemaCheck(input: SchemaCheckInput!): SchemaCheckPayload!
    updateRegistryVersionStatus(input: RegistryVersionUpdateInput!): RegistryVersion!
    updateBaseSchema(input: UpdateBaseSchemaInput!): UpdateBaseSchemaResult!
    updateSchemaServiceName(input: UpdateSchemaServiceNameInput!): UpdateSchemaServiceNameResult!
    schemaSyncCDN(input: SchemaSyncCDNInput!): SchemaSyncCDNPayload!
    enableExternalSchemaComposition(
      input: EnableExternalSchemaCompositionInput!
    ): EnableExternalSchemaCompositionResult!
    disableExternalSchemaComposition(
      input: DisableExternalSchemaCompositionInput!
    ): DisableExternalSchemaCompositionResult!
  }

  extend type Query {
    registryVersionCompareToPrevious(selector: RegistryVersionCompareToPreviousInput!): RegistryVersionComparePayload!
    registryVersions(selector: RegistryVersionsInput!, after: ID, limit: Int!): RegistryVersionConnection!
    registryVersion(selector: RegistryVersionInput!): RegistryVersion!
    """
    Requires API Token
    """
    latestVersion: RegistryVersion!
    """
    Requires API Token
    """
    latestComposableVersion: RegistryVersion!
  }

  input DisableExternalSchemaCompositionInput {
    organization: ID!
    project: ID!
  }

  """
  @oneOf
  """
  type DisableExternalSchemaCompositionResult {
    ok: Boolean
    error: String
  }

  input EnableExternalSchemaCompositionInput {
    organization: ID!
    project: ID!
    endpoint: String!
    secret: String!
  }

  """
  @oneOf
  """
  type EnableExternalSchemaCompositionResult {
    ok: ExternalSchemaComposition
    error: EnableExternalSchemaCompositionError
  }

  type ExternalSchemaComposition {
    endpoint: String!
  }

  extend type Project {
    externalSchemaComposition: ExternalSchemaComposition
  }

  type EnableExternalSchemaCompositionError implements Error {
    message: String!
    """
    The detailed validation error messages for the input fields.
    """
    inputErrors: EnableExternalSchemaCompositionInputErrors!
  }

  type EnableExternalSchemaCompositionInputErrors {
    endpoint: String
    secret: String
  }

  type UpdateSchemaServiceNameResult {
    ok: UpdateSchemaServiceNameOk
    error: UpdateSchemaServiceNameError
  }

  type UpdateSchemaServiceNameOk {
    updatedTarget: Target!
  }

  type UpdateSchemaServiceNameError implements Error {
    message: String!
  }

  type UpdateBaseSchemaResult {
    ok: UpdateBaseSchemaOk
    error: UpdateBaseSchemaError
  }

  type UpdateBaseSchemaOk {
    updatedTarget: Target!
  }

  type UpdateBaseSchemaError implements Error {
    message: String!
  }

  extend type Target {
    latestRegistryVersion: RegistryVersion
    baseSchema: String
    hasSchema: Boolean!
  }

  type SchemaConnection {
    nodes: [Schema!]!
    total: Int!
  }

  union Schema = SingleSchema | CompositeSchema

  type SingleSchema {
    id: ID!
    author: String!
    sdl: String!
    date: DateTime!
    commit: ID!
    metadata: String
  }

  type CompositeSchema {
    id: ID!
    author: String!
    sdl: String!
    date: DateTime!
    commit: ID!
    serviceName: String!
    serviceUrl: String
    metadata: String
  }

  union SchemaPublishPayload =
      SchemaPublishSuccess
    | SchemaPublishError
    | SchemaPublishMissingServiceError
    | SchemaPublishMissingUrlError
    | GitHubSchemaPublishSuccess
    | GitHubSchemaPublishError

  input SchemaPublishInput {
    service: ID
    url: String
    sdl: String!
    author: String!
    commit: String!
    force: Boolean
    """
    Accept breaking changes and mark schema as valid (if composable)
    """
    experimental_acceptBreakingChanges: Boolean
    metadata: String
    """
    Talk to GitHub Application and create a check-run
    """
    github: Boolean
  }

  input SchemaDeleteInput {
    serviceName: ID!
    force: Boolean
  }

  """
  @oneOf
  """
  type SchemaDeleteResult {
    ok: DeletedSchema
    errors: SchemaErrorConnection
  }

  type DeletedSchema {
    id: ID!
    author: String!
    date: DateTime!
    serviceName: String
  }

  union SchemaCheckPayload = SchemaCheckSuccess | SchemaCheckError | GitHubSchemaCheckSuccess | GitHubSchemaCheckError

  enum CriticalityLevel {
    Breaking
    Dangerous
    Safe
  }

  type SchemaChange {
    criticality: CriticalityLevel!
    message: String!
    path: [String!]
  }

  type SchemaError {
    message: String!
    path: [String!]
  }

  type SchemaChangeConnection {
    nodes: [SchemaChange!]!
    total: Int!
  }

  type SchemaErrorConnection {
    nodes: [SchemaError!]!
    total: Int!
  }

  type SchemaCheckSuccess {
    isComposable: Boolean!
    valid: Boolean! @deprecated
    initial: Boolean!
    changes: SchemaChangeConnection
  }

  type SchemaCheckError {
    isComposable: Boolean!
    valid: Boolean! @deprecated
    changes: SchemaChangeConnection
    errors: SchemaErrorConnection!
  }

  type GitHubSchemaCheckSuccess {
    message: String!
  }

  type GitHubSchemaCheckError {
    message: String!
  }

  type GitHubSchemaPublishSuccess {
    message: String!
  }

  type GitHubSchemaPublishError {
    message: String!
  }

  type SchemaPublishSuccess {
    initial: Boolean!
    isComposable: Boolean!
    valid: Boolean! @deprecated
    linkToWebsite: String
    message: String
    changes: SchemaChangeConnection
  }

  type SchemaPublishError {
    isComposable: Boolean!
    valid: Boolean! @deprecated
    linkToWebsite: String
    changes: SchemaChangeConnection
    errors: SchemaErrorConnection!
  }

  type SchemaPublishMissingServiceError {
    message: String!
  }

  type SchemaPublishMissingUrlError {
    message: String!
  }

  input SchemaCheckInput {
    service: ID
    sdl: String!
    github: GitHubSchemaCheckInput
  }

  input GitHubSchemaCheckInput {
    commit: String!
  }

  input RegistryVersionCompareInput {
    organization: ID!
    project: ID!
    target: ID!
    after: ID!
    before: ID!
  }

  input RegistryVersionCompareToPreviousInput {
    organization: ID!
    project: ID!
    target: ID!
    version: ID!
  }

  input RegistryVersionUpdateInput {
    organization: ID!
    project: ID!
    target: ID!
    version: ID!
    valid: Boolean!
  }

  type RegistryVersionCompareResult {
    changes: SchemaChangeConnection!
    diff: SchemaDiff!
    initial: Boolean!
  }

  type RegistryVersionCompareError {
    message: String!
  }

  union RegistryVersionComparePayload = RegistryVersionCompareResult | RegistryVersionCompareError

  type SchemaDiff {
    after: String!
    before: String!
  }

  input RegistryVersionsInput {
    organization: ID!
    project: ID!
    target: ID!
  }

  input RegistryVersionInput {
    organization: ID!
    project: ID!
    target: ID!
    version: ID!
  }

  input UpdateBaseSchemaInput {
    organization: ID!
    project: ID!
    target: ID!
    newBase: String
  }

  input UpdateSchemaServiceNameInput {
    organization: ID!
    project: ID!
    target: ID!
    version: ID!
    name: String!
    newName: String!
  }

  type RegistryVersion {
    id: ID!
    isComposable: Boolean!
    date: DateTime!
    action: RegistryAction!
    baseSchema: String
    schemas: SchemaConnection!
    supergraph: String
    sdl: String
    """
    Experimental: This field is not stable and may change in the future.
    """
    explorer(usage: SchemaExplorerUsageInput): SchemaExplorer!
  }

  union RegistryAction = RegistryAddAction | RegistryModifyAction | RegistryDeleteAction | RegistryNotApplicableAction

  type RegistryAddAction {
    id: ID!
    date: DateTime!
    serviceName: String
    serviceUrl: String
    commit: String!
    author: String!
  }

  type RegistryModifyAction {
    id: ID!
    date: DateTime!
    serviceName: String
    serviceUrl: String
    commit: String!
    author: String!
  }

  type RegistryDeleteAction {
    id: ID!
    date: DateTime!
    serviceName: String!
  }

  type RegistryNotApplicableAction {
    id: ID!
    date: DateTime!
    author: String!
    commit: String!
  }

  type RegistryVersionConnection {
    nodes: [RegistryVersion!]!
    pageInfo: PageInfo!
  }

  input SchemaSyncCDNInput {
    organization: ID!
    project: ID!
    target: ID!
  }

  type SchemaSyncCDNSuccess {
    message: String!
  }

  type SchemaSyncCDNError {
    message: String!
  }

  union SchemaSyncCDNPayload = SchemaSyncCDNSuccess | SchemaSyncCDNError

  input SchemaExplorerUsageInput {
    period: DateRangeInput!
  }

  type SchemaExplorer {
    types: [GraphQLNamedType!]!
    type(name: String!): GraphQLNamedType
    query: GraphQLObjectType
    mutation: GraphQLObjectType
    subscription: GraphQLObjectType
  }

  type SchemaCoordinateUsage {
    total: Int!
    isUsed: Boolean!
  }

  union GraphQLNamedType =
      GraphQLObjectType
    | GraphQLInterfaceType
    | GraphQLUnionType
    | GraphQLEnumType
    | GraphQLInputObjectType
    | GraphQLScalarType

  type GraphQLObjectType {
    name: String!
    description: String
    fields: [GraphQLField!]!
    interfaces: [String!]!
    usage: SchemaCoordinateUsage!
  }

  type GraphQLInterfaceType {
    name: String!
    description: String
    fields: [GraphQLField!]!
    interfaces: [String!]!
    usage: SchemaCoordinateUsage!
  }

  type GraphQLUnionType {
    name: String!
    description: String
    members: [GraphQLUnionTypeMember!]!
    usage: SchemaCoordinateUsage!
  }

  type GraphQLUnionTypeMember {
    name: String!
    usage: SchemaCoordinateUsage!
  }

  type GraphQLEnumType {
    name: String!
    description: String
    values: [GraphQLEnumValue!]!
    usage: SchemaCoordinateUsage!
  }

  type GraphQLInputObjectType {
    name: String!
    description: String
    fields: [GraphQLInputField!]!
    usage: SchemaCoordinateUsage!
  }

  type GraphQLScalarType {
    name: String!
    description: String
    usage: SchemaCoordinateUsage!
  }

  type GraphQLField {
    name: String!
    description: String
    type: String!
    args: [GraphQLArgument!]!
    isDeprecated: Boolean!
    deprecationReason: String
    usage: SchemaCoordinateUsage!
  }

  type GraphQLInputField {
    name: String!
    description: String
    type: String!
    defaultValue: String
    isDeprecated: Boolean!
    deprecationReason: String
    usage: SchemaCoordinateUsage!
  }

  type GraphQLArgument {
    name: String!
    description: String
    type: String!
    defaultValue: String
    isDeprecated: Boolean!
    deprecationReason: String
    usage: SchemaCoordinateUsage!
  }

  type GraphQLEnumValue {
    name: String!
    description: String
    isDeprecated: Boolean!
    deprecationReason: String
    usage: SchemaCoordinateUsage!
  }
`;
