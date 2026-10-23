# External facts the design relies on

Generated on 2026-10-21 from a two-pass research run. A researcher answered each
question from primary sources: official docs, Linear's SDK source and schema,
Slack's SDK source and method reference, and Railway's docs and CLI source. An
independent verifier then tried to refute every load-bearing claim. Each entry
shows the verifier's verdict where one exists (CONFIRMED / CORRECTED /
UNVERIFIABLE).

The sandbox could not reach linear.app, slack.com or railway.com directly, so
some "official-doc" facts were read through search excerpts. Their confidence is
marked medium. Re-check those against the live pages, and against a test
workspace, before relying on them in production. `docs/deploy.md` lists the open
questions that need a live test.

## Linear OAuth 2.0

- **Q1 How I got these facts (read this first)**  
  I could not load any linear.app page directly. WebFetch failed with
  'getaddrinfo ENOTFOUND linear.app', and the same happened for
  developers.linear.app, www.linear.app and nango.dev. A curl to linear.app from
  the shell was denied by the sandbox. So every 'official-doc' fact below comes
  from search-engine excerpts of the official Linear pages (WebSearch limited to
  linear.app). Where I could, I checked them against Linear's own source code:
  the GraphQL schema in github.com/linear/linear
  (packages/sdk/src/schema.graphql, commit 67791e5, dated 2026-10-19) and the
  official linear/linear-agent-demo repo. Facts that only third-party projects
  state are labeled 'community'.  
  _Source (inferred, high):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CONFIRMED.
  linear.app is not reachable from this sandbox. WebFetch fails with ENOTFOUND,
  curl gets a 403 on CONNECT, and web.archive.org is blocked as well. The Linear
  MCP search_documentation tool only indexes the product docs
  (linear.app/docs/*), not the developer docs. So the developer-doc facts below
  rest on WebSearch excerpts limited to linear.app, checked against primary
  source code where possible. The scratchpad linear-schema.graphql is
  byte-identical to the current file on master (sha256 3a98f6dc...; 53,325
  lines; shallow clone HEAD 67791e5, 2026-10-19). Other primary sources: the
  official linear/linear-agent-demo repo (HEAD 3675104, 2025-05-23),
  packages/sdk/src/error.ts on master,…
  (https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)

- **Q1 Authorize URL and its query params**  
  GET https://linear.app/oauth/authorize. Parameters: client_id (required);
  redirect_uri (required, must exactly match one registered on the app);
  response_type=code (required); scope (required, a COMMA-separated list; 'read'
  is the default and always present); state (optional but recommended, for CSRF;
  it is echoed back on the redirect); prompt=consent (optional, shows the
  consent screen every time even if the scopes were already granted, which helps
  users connect several workspaces); actor (optional: 'user' is the default and
  creates resources as the authorizing user, 'app' creates them as the
  application). Note: Linear's own agent demo (oauthHelper.ts) joins scopes with
  a space. The docs say commas, so send commas.  
  _Source (official-doc, high):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CONFIRMED.
  The authorize URL is GET https://linear.app/oauth/authorize. It takes
  client_id, redirect_uri, response_type=code, scope (comma-separated per the
  docs; read is the default and always included), state, prompt=consent, and
  actor (user is the default, app is for agents and service accounts). The
  official demo (src/lib/oauthHelper.ts) sets client_id, redirect_uri, state,
  response_type=code and actor=app. It joins scopes with a SPACE and defaults to
  ['read','write','app:assignable','app:mentionable'], so Linear apparently
  accepts spaces too. Follow the docs and send commas.
  (https://github.com/linear/linear-agent-demo/blob/main/src/lib/oauthHelper.ts)

- **Q1 Token URL and code exchange format**  
  POST https://api.linear.app/oauth/token with Content-Type:
  application/x-www-form-urlencoded. Body: grant_type=authorization_code, code,
  redirect_uri (the same one used to authorize), client_id, and either
  client_secret or code_verifier (for PKCE). Linear's official demo sends
  exactly grant_type, code, redirect_uri, client_id and client_secret as
  form-encoded fields. The response contains access_token, token_type 'Bearer',
  expires_in (the docs example shows 86399), scope (e.g. 'read write') and
  refresh_token.  
  _Source (source-code, high):_
  https://github.com/linear/linear-agent-demo/blob/main/src/lib/oauthHelper.ts
  _Verifier:_ CONFIRMED. The demo POSTs to https://api.linear.app/oauth/token
  with Content-Type application/x-www-form-urlencoded and the body
  grant_type=authorization_code, code, redirect_uri, client_id, client_secret.
  Its TokenResponse type has access_token, token_type, expires_in,
  refresh_token? and scope?. The docs example shows token_type Bearer,
  expires_in 86399 (24h minus 1s), scope 'read write' and a refresh_token. With
  PKCE you send code_verifier, and client_secret becomes optional.
  (https://github.com/linear/linear-agent-demo/blob/main/src/lib/oauthHelper.ts)

- **Q1 Revoke URL and its params**  
  POST https://api.linear.app/oauth/revoke. Put the token to revoke in the
  'token' form field. Add token_type_hint=access_token or refresh_token when you
  know which it is. Do not combine 'token' with the legacy fields. Responses:
  200 on success, 400 if revocation fails (e.g. the token is already revoked),
  401 if authenticating with the token fails. Legacy style, used in Linear's
  demo: POST /oauth/revoke with an 'Authorization: Bearer <access_token>'
  header. Rotating the client secret does NOT revoke tokens already granted. A
  third-party live test (PSLinear PR #21) reports that after revocation Linear
  rejected both the old access token and the old refresh token.  
  _Source (official-doc, medium):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CORRECTED
  (one sub-claim): The revoke endpoint is POST
  https://api.linear.app/oauth/revoke, with the RFC 7009 'token' field plus an
  optional token_type_hint (access_token|refresh_token). 'token' must not be
  combined with the legacy fields. Responses are 200 on success, 400 if the
  token cannot be revoked (e.g. already revoked) and 401 if authenticating with
  the token fails. All of that is CONFIRMED. A changelog entry says the legacy
  access_token/refresh_token form fields are deprecated but still work. The
  demo's revoke (src/routes/oauth.ts) is CONFIRMED to send only an
  'Authorization: Bearer <access_token>' header. CORRECTION: rotating the client
  secret does not revoke access or refresh toke…
  (https://linear.app/developers/oauth-2-0-authentication)

- **Q1 PKCE support**  
  Yes. The authorize request takes code_challenge and code_challenge_method. The
  docs list 'plain' or 'S256', but a Linear changelog entry says OAuth now
  requires an explicit S256 method for PKCE authorization requests, so always
  use S256. The token exchange then takes code_verifier, and client_secret
  becomes optional (public client). An earlier changelog entry added PKCE
  support without a client secret. I could not confirm the date of the 'S256
  required' change. A confidential server-side Next.js app can use PKCE and also
  send client_secret.  
  _Source (official-doc, medium):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CORRECTED
  (date found): PKCE with code_challenge, code_challenge_method and
  code_verifier is CONFIRMED. PKCE without a client secret was added in the
  2025-04-10 changelog entry ('New search'). The 'Required an explicit S256
  method for PKCE authorization requests' entry appears in the OAuth section of
  the 2026-10-08 changelog entry ('Stacked pull requests'). The docs table still
  lists plain|S256, and the docs example uses S256. Always send
  code_challenge_method=S256. On refresh, tokens issued through PKCE need only
  client_id; client_secret is optional. A confidential server can still send
  client_secret. (https://linear.app/changelog/2026-10-08-stacked-pull-requests)

- **Q2 Full list of scopes and what each allows**  
  Listed on the OAuth 2.0 page: read (default, always present; read access to
  the user's account); write (write access to the user's account, which covers
  ALL mutations the user can perform); issues:create (create new issues and
  their attachments only); comments:create (create new issue comments only);
  timeSchedule:write (create and modify time schedules); admin (full access to
  admin-level endpoints; the docs say never request it unless absolutely
  needed). Agent/app scopes, for actor=app only: app:assignable (the app user
  can be assigned to issues and added to projects) and app:mentionable (the app
  can be @mentioned in issues, documents and other editor surfaces).
  Changelog-only scopes: initiative:read and initiative:write (workspace-level
  initiatives for app-actor apps, added 2025-08-14), customer:read and
  customer:write (Customer, CustomerStatus and CustomerTier entities). A
  2025-10-02 …  
  _Source (official-doc, medium):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CONFIRMED,
  with additions. The docs list read (default, always present), write,
  issues:create (new issues and their attachments), comments:create,
  timeSchedule:write and admin (never request unless absolutely needed).
  app:assignable and app:mentionable are also CONFIRMED in source code: they are
  the official demo's default actor=app scopes. initiative:read/write and
  customer:read/write are CONFIRMED for actor=app in the 2025-08-14 changelog
  ('Product Intelligence (Technology Preview)'). The 2025-10-02 changelog fixed
  those four scopes for client_credentials tokens. That entry also added:
  existing app tokens can be upgraded to more scopes through the
  authorization_code flow without being rev…
  (https://linear.app/changelog/2025-10-02-issue-discussion-summaries)

- **Q2 Which scopes the planner's operations need**  
  Updating an issue's assignee or state (issueUpdate with assigneeId/stateId)
  needs 'write'. issues:create covers creation only, and no narrower update
  scope is documented. Creating a comment needs 'comments:create', which 'write'
  also covers. Updating a project milestone's targetDate
  (projectMilestoneUpdate, ProjectMilestoneUpdateInput.targetDate: TimelessDate)
  needs 'write'. Updating a project's lead (projectUpdate,
  ProjectUpdateInput.leadId) needs 'write'. In practice, request 'read,write'.
  The input fields are confirmed in the schema. The scope mapping is my
  inference from the scope descriptions, because Linear documents no
  per-mutation scope table. The user's own workspace permissions also still
  apply (e.g. team or private-team access).  
  _Source (inferred, medium):_
  https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED (input fields), still INFERRED (scope mapping). The
  schema has IssueUpdateInput.assigneeId and stateId (String),
  ProjectMilestoneUpdateInput.targetDate (TimelessDate) and
  ProjectUpdateInput.leadId (String). IssueUpdateInput also has delegateId, for
  delegating an issue to an agent. The docs describe issues:create as creating
  issues and attachments only, and Linear publishes no per-mutation scope table.
  So 'read,write' is the safe request for issueUpdate, projectUpdate,
  projectMilestoneUpdate and commentCreate. The user's own team and private-team
  permissions still apply.
  (https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)

- **Q3 What actor=app means and what identity the token acts as**  
  By default, every Linear auth method treats the authenticating user as the API
  actor. Adding actor=app to the authorize URL makes it an app installation
  instead: the user authorizes installing the app in the workspace, and actions
  taken with the resulting token come from the app itself. Mutations (issues,
  comments, status changes) are performed by a dedicated 'app user' that Linear
  creates for the installation. The setting is tied to that authorization and
  its access token. The older actor=application mode is deprecated in favor of
  actor=app, though apps already using it can keep doing so. Since 2025-07 the
  schema descriptions say actor=app instead of actor=application.  
  _Source (official-doc, high):_
  https://linear.app/developers/oauth-actor-authorization _Verifier:_ CONFIRMED.
  By default the authenticating user is the actor. actor=app makes the installed
  app user the actor, and the setting is tied to that authorization and its
  token. actor=application is deprecated in favor of actor=app, but apps already
  using it can continue. Minor CORRECTION: the current schema still has one
  'actor=application' mention (AttachmentCreateInput.createAsUser description),
  and the claimed '2025-07' date cannot be checked from a shallow clone.
  (https://linear.app/developers/oauth-actor-authorization)

- **Q3 Who can approve an actor=app install**  
  A workspace admin. The Agents getting-started page says that because the
  install is workspace-scoped, admin permissions are required to complete it.
  The product docs say 'App users are installed and managed by workspace admins'
  and that the admin picks which teams the agent can access during install.
  Plain actor=user OAuth needs no admin in general, but if the workspace (on a
  paid plan) has turned on Third-Party App Approvals, a member's install becomes
  an approval request for an admin (or owner on Enterprise). Creating or
  managing the OAuth app itself (Settings > Administration > API) also requires
  admin permissions in the workspace where you create it.  
  _Source (official-doc, high):_ https://linear.app/developers/agents
  _Verifier:_ CONFIRMED, with corrections. The Agents getting-started doc says
  the actor=app install is workspace-scoped and needs an admin. The product docs
  say 'Workspace admins can install agents', admins pick teams during install,
  and admins can change or revoke team access later; the app gets a
  PermissionChange webhook and the schema has
  AppUserTeamAccessChangedWebhookPayload. CORRECTION for Enterprise: per the
  Members and roles doc, workspace OWNERS hold 'OAuth application approvals and
  team access management'. Third-Party App Approvals exist on paid plans and are
  enabled by the owner on Enterprise, or by an admin otherwise. MISSED: the
  2025-04-10 changelog says 'OAuth applications from the same wo…
  (https://linear.app/docs/members-roles)

- **Q3 How comments and updates are attributed under actor=app**  
  All mutations are attributed to the app user. Create mutations take an
  optional createAsUser (a name) and displayIconUrl (an avatar URL), so the item
  renders as 'Name (via Application)'. These exist on issueCreate,
  commentCreate, attachment creation and customer needs, and only in actor=app
  mode. issueUpdate, projectUpdate and projectMilestoneUpdate have NO
  createAsUser field (I checked IssueUpdateInput in the schema), so updates show
  the app user as the actor. Comment.botActor (ActorBot) records the bot, and
  Comment.user is null for bot-created comments without a user. Conclusion: you
  cannot attribute an UPDATE to a real human through an actor=app token.  
  _Source (schema-file, high):_
  https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED, with one CORRECTION. In the schema, createAsUser exists
  only on AttachmentCreateInput, CommentCreateInput, CustomerNeedCreateInput and
  IssueCreateInput. displayIconUrl accompanies it. IssueUpdateInput,
  ProjectUpdateInput and ProjectMilestoneUpdateInput have neither, so updates
  made with an actor=app token cannot be attributed to a human. CORRECTION:
  'Comment.user is null for bot comments' does NOT describe actor=app comments.
  The schema says Comment.user is null only for 'integrations or bots without a
  user association'. The official demo finds its own comments with
  comment.userId === viewer.id, so actor=app comments carry the app user as
  Comment.user/userId. Comment.botActor (Ac…
  (https://github.com/linear/linear-agent-demo/blob/main/src/lib/agent.ts)

- **Q3 Can one OAuth app also do normal per-user (actor=user) sign-in so PM
  edits are attributed to the human?**  
  Very likely yes, but I found no explicit statement. The actor mode is a
  per-authorization parameter ('tied to the authorization and its access
  token'), and actor=user is simply the default. So the same client_id should be
  able to (a) be installed once with actor=app by an admin and (b) be authorized
  by each PM with no actor param (or actor=user). Each authorization gives a
  separate token and refresh token. Supporting signs:
  OAuthAuthorizationWebhookPayload has an 'activeTokensForUser' count per user
  per client, and third-party projects (triage-factory PRs #1180/#1186) run an
  actor=app install plus per-member actor=user 'Connect' flows on separate
  redirect URIs. Test this before relying on it.  
  _Source (inferred, medium):_
  https://linear.app/developers/oauth-actor-authorization _Verifier:_
  UNVERIFIABLE (no explicit doc found; still plausible). Supporting signs: actor
  is per-authorization; the schema's
  OAuthAuthorizationWebhookPayload.activeTokensForUser counts tokens per user
  per client. A caution the first researcher missed: the OAuth docs say 'If you
  first generate an app actor token via a different grant type, you will not be
  able to hold multiple app tokens in parallel'. That limits APP-ACTOR tokens,
  not user tokens, but it means one app should not mix an actor=app install with
  client_credentials. A 2021 changelog also says that if a user holds more than
  10 tokens for the same application and permissions, the oldest are revoked
  automatically. That may be stale, but it mat…
  (https://linear.app/developers/oauth-2-0-authentication)

- **Q3 Restrictions on actor=app tokens**  
  (1) actor=app installs cannot request the 'admin' scope (Agents docs). (2) App
  users cannot sign in to the app, use admin functionality or manage users, and
  they are not billable seats (product docs). (3) viewer works, and it returns
  the app user, not the human who clicked Authorize; User.app == true identifies
  it. The schema has User.app: Boolean ('Whether the user is an app'). The
  'viewer returns the app user' behavior is confirmed only by third parties:
  aws-samples LINEAR_SETUP_GUIDE and moviecal #286, where the client_credentials
  viewer returned the app name. (4) The app's team access is limited to the
  teams the admin chose at install. (5) app:assignable and app:mentionable are
  opt-in. The schema says active app users need the assignments or mentions
  capability for isAssignable or isMentionable. The Agents API is labeled
  Developer Preview, so details may change.  
  _Source (official-doc, medium):_ https://linear.app/developers/agents
  _Verifier:_ CONFIRMED, and partly upgraded to source-code. (1) actor=app
  cannot request the admin scope (Agents doc excerpt). (2) Agents cannot sign
  in, use admin functionality or manage users, and they are not billable seats
  (product doc 'AI Agents', read through the Linear MCP). (3) viewer returns the
  APP USER: the official demo's getMe() calls linear.viewer and uses me.id and
  me.name to recognize its own comments and @mentions. The schema has User.app:
  Boolean! ('Whether the user is an app'). (4) Team access is what the admin
  selects at install and can be changed later. (5) The schema says
  User.isAssignable needs the assignments capability for active app users and
  isMentionable needs the mentions ca…
  (https://linear.app/docs/agents-in-linear)

- **Q4 Access token lifetime and refresh tokens**  
  Yes. The changelog of 2025-09-19 announced that user-initiated OAuth moves to
  short-lived access tokens valid for 24 hours and paired with refresh tokens.
  Apps created on or after Oct 1, 2025 have refresh tokens on by default, with
  no way to turn them off. Existing apps had until Apr 1, 2026 to migrate. The
  current docs say all OAuth2 applications were migrated to the refresh token
  system on April 1, 2026. Access tokens last 24h (the example shows expires_in
  86399). Before migration, apps without refresh tokens got 10-year access
  tokens. For the transition there was a temporary endpoint, POST
  https://api.linear.app/oauth/migrate_old_token. A third-party implementation
  (AutoGPT PR #10998) calls it with 'Authorization: Bearer <old token>' and
  form-encoded client_id and client_secret. I could not confirm whether that
  endpoint still works after Apr 1, 2026. I found no documented lifetime fo…  
  _Source (changelog, high):_
  https://linear.app/changelog/2025-09-19-auto-apply-triage-suggestions
  _Verifier:_ CONFIRMED, with a CORRECTION. The 2025-09-19 changelog announced
  24h access tokens paired with refresh tokens for apps created from Oct 1,
  2025, and set Apr 1, 2026 as the deadline for existing apps. The docs say all
  OAuth2 apps were migrated on Apr 1, 2026. CORRECTION: the 2026-05-21 changelog
  ('Project Slack channels') says /oauth/migrate_old_token now returns 410 Gone
  and old-token migration is no longer supported. 'No way to turn refresh tokens
  off' is not confirmed verbatim, but it is moot. I found no documented
  refresh-token lifetime or inactivity expiry.
  (https://linear.app/changelog/2026-05-21-project-slack-channels)

- **Q4 Refresh request format and rotation**  
  POST https://api.linear.app/oauth/token, form-encoded, with
  grant_type=refresh_token and refresh_token=<token>. client_id and
  client_secret go in the body, or are optional if you use HTTP Basic auth
  (Authorization: Basic base64(client_id:client_secret)). Refresh tokens ROTATE:
  a successful refresh returns a new access token AND a new refresh token, and
  the previous ones are invalidated. There is a 30-minute grace period: if you
  made a valid refresh request but lost the response, you can replay the
  original request for up to 30 minutes to get the new refresh token.
  Third-party reports (Nango, PSLinear, triage-factory) confirm the rotation and
  that reusing a stale refresh token gives 'invalid_grant'. Concurrent refreshes
  from several processes are the most common cause. Use a single-flight lock or
  compare-and-swap in Postgres.  
  _Source (official-doc, high):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CONFIRMED.
  POST https://api.linear.app/oauth/token with grant_type=refresh_token and
  refresh_token. Client credentials go either in HTTP Basic (then body
  client_id/secret are optional) or in the body. For PKCE tokens, client_id
  alone is enough. Each refresh returns a NEW access token and a NEW refresh
  token. If the response is lost, the original request can be replayed for 30
  minutes to get the new refresh token. NOT CONFIRMED: whether the OLD access
  token stops working right after a refresh; the docs excerpts are silent. The
  2026-10-08 changelog says Linear reduced rate-limit (Cloudflare) errors caused
  by frequent OAuth token rotation. Single-flight refresh with a Postgres row
  lock is stil… (https://linear.app/developers/oauth-2-0-authentication)

- **Q5 Does Linear support client_credentials?**  
  Yes, since the 2025-09-19 changelog, for OAuth2 apps that talk
  server-to-server and cannot run a user-initiated flow with refresh tokens. You
  must first turn on 'client credentials tokens' in the OAuth2 app settings.
  Request: POST https://api.linear.app/oauth/token with
  grant_type=client_credentials, scope (comma-separated, e.g. read,write) and
  client credentials (body or HTTP Basic). The token is an app actor token with
  access to all PUBLIC teams in the workspace, is valid for 30 days, and has no
  refresh token. On a 401, fetch a new one. Linear recommends requesting a new
  token at the start of each run and never storing it as a long-lived key. An
  app can have up to 1000 active client_credentials tokens at once if they all
  use the same scopes. Requesting different scopes revokes ALL existing app
  actor tokens for the app, which may include actor=app install tokens;
  unconfirmed. The initi…  
  _Source (official-doc, medium):_
  https://linear.app/developers/oauth-2-0-authentication _Verifier:_ CONFIRMED,
  with additions. client_credentials must be enabled on the app; the schema's
  OAuthApplicationGrantType enum is authorization_code|client_credentials, and
  authorization_code is always included. The token is an app actor token for all
  PUBLIC teams, valid 30 days, with no refresh token: re-fetch on a 401 and
  request a fresh token per run. Up to 1000 tokens can be active in parallel if
  they share the same scopes. A different scope set revokes and replaces ALL app
  actor tokens. MISSED: (a) rotating the client secret immediately invalidates
  all client_credentials tokens. (b) 'If you first generate an app actor token
  via a different grant type, you will not be able to hold multiple app t…
  (https://linear.app/developers/oauth-2-0-authentication)

- **Q6 How to find the authorizing user and the workspace after OAuth**  
  Run POST https://api.linear.app/graphql with 'Authorization: Bearer
  <access_token>' and the query { viewer { id name email displayName admin app }
  organization { id name urlKey } }. The schema confirms Query.viewer: User!
  ('The currently authenticated user making the API request') and
  Query.organization: Organization! ('The authenticated user's workspace'), with
  Organization.id, name and urlKey, and User.id, name, email, admin and app. For
  an actor=user token, viewer is the human. For an actor=app or
  client_credentials token, viewer is the app user (app=true), so the human
  installer is not available from viewer. The OAuthAuthorizationWebhookPayload
  (with userId and organizationId) and OAuthAppWebhookPayload (with an
  oauthClientId 'that was revoked' and organizationId) webhooks carry user and
  org IDs for authorization and revocation events. Store organization.id as the
  tenant key.  
  _Source (schema-file, high):_
  https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED in the schema. Query.viewer: User! ('The currently
  authenticated user making the API request'). Query.organization: Organization!
  ('The authenticated user's workspace'), with id: ID!, name and urlKey. User
  has id, name, email, displayName, admin, owner, guest and app. For actor=app
  tokens viewer is the app user (confirmed by the demo source).
  OAuthAuthorizationWebhookPayload has userId, user, oauthClientId, oauthClient,
  organizationId, activeTokensForUser and action. OAuthAppWebhookPayload has
  oauthClientId ('that was revoked'), organizationId and action, but no userId.
  Using organization.id as the tenant key is sound. The SDK sends
  'Authorization: Bearer <token>' for an accessTok…
  (https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)

- **Q7 Rate limits for OAuth apps**  
  Requests: OAuth app 5,000 requests per hour per user (or app user); API key
  2,500 per hour per user; unauthenticated 600 per hour per IP. Complexity:
  OAuth app 2,000,000 points per hour per user (or app user); API key 3,000,000
  per user; unauthenticated 100,000 per IP. Any single query over 10,000 points
  is always rejected. Scoring: 0.1 per property, 1 per object, and connections
  multiply their children by the 'first' or 'last' argument (default 50). The
  limiter is a leaky bucket that refills at LIMIT/PERIOD. Linear dynamically
  raises limits for workspace-level OAuth apps using Actor Authorization
  (actor=app) based on the workspace's number of paid users; no formula is
  published. Third-party aws-samples reports 3,000,000 complexity points per
  hour per installed app. Because budgets are per user or app user, every PM's
  actor=user token has its own budget and the actor=app install has ano…  
  _Source (official-doc, medium):_ https://linear.app/developers/rate-limiting
  _Verifier:_ CONFIRMED. Requests per hour: OAuth 5,000 per user or app user;
  API key 2,500; unauthenticated 600 per IP. Complexity points per hour: OAuth
  2,000,000; API key 3,000,000; unauthenticated 100,000. A single query over
  10,000 points is always rejected. Scoring: 0.1 per property, 1 per object,
  connections multiplied by first/last (default 50), rounded up. Leaky bucket
  refilling at LIMIT/PERIOD. Linear raises limits dynamically for
  workspace-level actor=app apps based on paid users, with no formula published.
  Support can raise limits case by case. The third-party claims (aws-samples 3M
  per app, searchIssues 30/min) are UNVERIFIABLE.
  (https://linear.app/developers/rate-limiting)

- **Q7 Rate-limit response headers and error shape**  
  Request-limit headers: X-RateLimit-Requests-Limit,
  X-RateLimit-Requests-Remaining, X-RateLimit-Requests-Reset (UTC epoch ms).
  Complexity headers: X-Complexity (this query's cost),
  X-RateLimit-Complexity-Limit, X-RateLimit-Complexity-Remaining,
  X-RateLimit-Complexity-Reset. Endpoint-specific headers:
  X-RateLimit-Endpoint-Name, X-RateLimit-Endpoint-Requests-Limit, -Remaining and
  -Reset. A third party observed these only on a refusal, sent in lowercase.
  When limited, the GraphQL error has extensions.code 'RATELIMITED'. The docs
  describe the HTTP status as 400, but a third party (triage-factory PR #1228)
  captured HTTP 429 on an endpoint-limit refusal, so handle both. The schema
  also has Query.rateLimitStatus: RateLimitPayload { identifier, kind, limits[{
  type, allowedAmount, remainingAmount, requestedAmount, period, reset }] } for
  checking the budget yourself.  
  _Source (official-doc, medium):_ https://linear.app/developers/rate-limiting
  _Verifier:_ CONFIRMED, with an addition from source code. The docs describe
  X-RateLimit-Requests-Limit/Remaining/Reset (UTC epoch ms), X-Complexity,
  X-RateLimit-Complexity-Limit/Remaining/Reset, and X-RateLimit-Endpoint-Name
  plus X-RateLimit-Endpoint-Requests-Limit/Remaining/Reset (added in the
  2025-02-13 changelog). The docs say GraphQL rate-limit errors come back as
  HTTP 400 with RATELIMITED in errors[].extensions.code. The official SDK
  (packages/sdk/src/error.ts) classifies an error as Ratelimited when
  errors[0].extensions.type === 'ratelimited' OR the HTTP status is 429. It also
  reads the Retry-After header (seconds) and the x-ratelimit-* headers. So
  handle all three: 400 with RATELIMITED, extensio…
  (https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/error.ts)

### Added by the verifier

- **MISSED: OAuth app distribution (private vs public)**  
  In the schema, OAuthApplication.distribution is private|public: 'Private
  applications are only installable by the owning workspace.' The
  oauth-app-manifests doc says the default is private, and it can be set to
  public in a manifest or with distribution=public. A single-company planner can
  stay private; installing into other workspaces needs public. The schema also
  exposes [ALPHA] mutations: oauthApplicationCreate, oauthApplicationUpdate,
  oauthApplicationRotateSecret, oauthApplicationRotateWebhookSecret and
  oauthApplicationArchive. They only act on apps created by the calling OAuth
  app, so the planner does not need them.  
  _Source (schema-file, medium):_
  https://linear.app/developers/oauth-app-manifests

- **MISSED: Webhook quotas**  
  The 2026-10-08 changelog added webhook quotas: 30 webhooks per team and 50 per
  workspace. This matters if the planner creates workspace or team webhooks
  through webhookCreate. OAuth-app-level webhooks (configured on the app)
  probably do not count, but that is unconfirmed.  
  _Source (changelog, medium):_
  https://linear.app/changelog/2026-10-08-stacked-pull-requests

- **MISSED: Token formats**  
  Linear's official linear-solutions integration guide documents OAuth tokens as
  'lin_oauth_...' and API keys as 'lin_api_...'. @linear/sdk 98.0.0 sends an
  accessToken as 'Authorization: Bearer <token>' (adding the prefix if it is
  missing) and an apiKey raw, without Bearer.  
  _Source (source-code, high):_
  https://github.com/linear/linear-solutions/blob/main/integration_guides/README.md

### Open questions

- Official Linear docs could not be fetched directly (WebFetch DNS failure on
  linear.app). Every official-doc fact comes from search-engine excerpts. Have
  someone with browser access check the live pages: oauth-2-0-authentication,
  oauth-actor-authorization, agents and rate-limiting.
- Can the same OAuth client_id hold both an actor=app install and per-user
  actor=user grants in one workspace at the same time? This is very likely but
  not explicitly documented. Check it with a test workspace.
- Does a client_credentials request with a different scope set revoke the
  actor=app install tokens (the docs say 'all existing app actor tokens for the
  app are revoked')? Which workspace is a client_credentials token bound to?
- Does the refresh token itself have a lifetime or an inactivity expiry? Nango
  claims an inactivity expiry, but I found no day count in Linear's docs.
- Is the temporary POST /oauth/migrate_old_token endpoint still live after the
  Apr 1, 2026 cutover? This does not matter for a new app.
- Is S256 now strictly required for PKCE (the changelog says yes, the docs table
  still lists plain)? Exact date of that change.
- For actor=app (dynamic limits), what is the formula for raising the limit
  based on paid users? Does the rate-limit HTTP status come back as 400 or 429
  for the hourly limits?
- Is there any way to get the human installer of an actor=app install (e.g.
  OAuthAuthorizationWebhookPayload.userId for app installs)? viewer only returns
  the app user.
- The live developer docs (oauth-2-0-authentication, oauth-actor-authorization,
  agents, rate-limiting) still cannot be fetched from this sandbox. Every
  official-doc fact rests on search-engine excerpts plus the product-doc MCP.
  Someone with browser access should spot-check them.
- Can one OAuth app hold an actor=app authorization_code install AND per-PM
  actor=user grants at the same time? This is not documented. The docs'
  'different grant type => cannot hold multiple app tokens in parallel' rule
  covers app actor tokens only.
- Does refreshing invalidate the previous ACCESS token immediately, or does it
  stay valid until it expires? The docs excerpts are silent.
- Is the 2021 'more than 10 tokens per user per app and permissions => oldest
  revoked' rule still in force under the refresh-token system?
- Does the refresh token have an absolute or inactivity lifetime? No number was
  found in Linear sources.
- Does the S256-explicit PKCE change (2026-10-08) reject requests that omit
  code_challenge_method, or only requests that use plain?
- Who exactly can create an OAuth application (member, admin or owner) on
  non-Enterprise paid plans?
- Do OAuth-app-level webhooks count toward the new 30-per-team /
  50-per-workspace webhook quota?

## Linear webhooks

- **1. What is the signature header, which algorithm and encoding does it use,
  and what does it sign?**  
  Header: `Linear-Signature`. The SDK reads it in lowercase as
  `linear-signature` (client.ts L11:
  `export const LINEAR_WEBHOOK_SIGNATURE_HEADER = "linear-signature";`). The
  value is HMAC-SHA256 over the exact raw request body bytes, encoded as
  lowercase hex with no `sha256=` prefix. It is compared in constant time.
  client.ts L329:
  `const verificationBuffer = Buffer.from(crypto.createHmac("sha256", this.secret).update(rawBody).digest("hex"));`
  followed by `crypto.timingSafeEqual(verificationBuffer, signatureBuffer)`. The
  official docs (seen via search snippets) say the same: "hex-encoded
  HMAC-SHA256 signature of the raw body contents, signed using the webhook's
  signing secret". They also warn against re-stringifying parsed JSON before
  verifying. Checked at linear/linear commit 67791e5 (2026-10-19). The published
  npm package @linear/sdk@98.0.0 (dist/webhooks-BtY8wrj8.mjs) has the same
  code.  
  _Source (source-code, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/webhooks/client.ts
  _Verifier:_ CONFIRMED. I re-read client.ts at linear/linear master.
  `git ls-remote` showed master is 67791e535db585eedc5c7b7805f43d4e8af5d2b9, and
  the file at that pinned SHA is byte-identical to master. L11 is
  `LINEAR_WEBHOOK_SIGNATURE_HEADER = "linear-signature"`. L329 computes
  `crypto.createHmac("sha256", this.secret).update(rawBody).digest("hex")`,
  which is lowercase hex with no `sha256=` prefix, and compares it with
  `crypto.timingSafeEqual` after a length check. Points the first researcher did
  not mention: (a) `verify()` never returns false. It throws
  `Error("Invalid webhook signature")` and the caller has to catch it. (b) The
  comparison is on the hex strings' bytes, so it is case-sensitive and do…
  (https://github.com/linear/linear/blob/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/webhooks/client.ts#L328-L355)

- **Quote of the SDK's verify() implementation (raw file from GitHub)**  
  packages/sdk/src/webhooks/client.ts lines 328-355 (permalink
  https://github.com/linear/linear/blob/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/webhooks/client.ts#L328-L355):
  ```ts public verify(rawBody: Buffer, signature: string, timestamp?: number |
  string): boolean { const verificationBuffer =
  Buffer.from(crypto.createHmac("sha256",
  this.secret).update(rawBody).digest("hex")); const signatureBuffer =
  Buffer.from(signature); if (verificationBuffer.length !==
  signatureBuffer.length) { throw new Error("Invalid webhook signature"); } if
  (!crypto.timingSafeEqual(verificationBuffer, signatureBuffer)) { throw new
  Error("Invalid webhook signature"); } // Only the timestamp in the signed body
  can establish freshness. timestamp =
  this.parseBodyAsWebhookPayload(rawBody)?.webhookTimestamp; if (timestamp ===
  undefined || timestamp === null) { throw new Error("Missing webhook
  timestam…
  _Source (source-code, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/webhooks/client.ts
  _Verifier:_ CONFIRMED verbatim. Lines 328-355 and the constants at L11-14
  (`linear-signature`, `linear-timestamp`, `webhookTimestamp`,
  `5 * 1024 * 1024`) match the quote exactly. I downloaded the npm tarball
  https://registry.npmjs.org/@linear/sdk/-/sdk-98.0.0.tgz. Its
  package/dist/webhooks-BtY8wrj8.mjs L218-225 contains the same logic in
  compiled form (`Math.abs(Date.now() - timestamp) > 1e3 * 60`). That module's
  only import is Node `crypto`.
  (https://github.com/linear/linear/blob/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/webhooks/client.ts#L328-L355)

  ```
- **What secret signs the webhook?**  
  Workspace webhooks use the per-webhook signing secret, `Webhook.secret`. The
  schema says: "A secret token used to sign webhook payloads with HMAC-SHA256
  ... Automatically generated if not provided during creation." You can set it
  through `WebhookCreateInput.secret`. The mutation `webhookRotateSecret`
  "generat[es] a new HMAC-SHA256 key ... The old secret is immediately
  invalidated." In the UI the secret is on the webhook's detail page (official
  docs). OAuth applications have one app-level webhook signing secret:
  `OAuthApplicationCreatePayload.webhookSecret`, described as "The webhook
  signing secret", plus the [ALPHA] mutation
  `oauthApplicationRotateWebhookSecret`. The secret belongs to the OAuth app,
  not to each installation, so one secret probably verifies deliveries for every
  workspace that installs the app. That last point is my inference from the
  schema.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ Workspace webhooks: CONFIRMED. Schema `Webhook.secret: String`
  reads: "A secret token used to sign webhook payloads with HMAC-SHA256 ...
  Automatically generated if not provided during creation."
  `WebhookCreateInput.secret` and `WebhookUpdateInput.secret` both exist.
  `webhookRotateSecret(id)` reads: "generating a new HMAC-SHA256 key and
  returning it. The old secret is immediately invalidated." It returns
  `WebhookRotateSecretPayload.secret: String!`. OAuth apps: CORRECTED, the
  framing was misleading. `OAuthApplicationCreatePayload.webhookSecret` and
  `oauthApplicationRotateWebhookSecret` belong to [ALPHA] mutations for OAuth
  applications "created by the calling OAuth application" (programmatic…
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/schema.graphql)

- **2. What gives replay protection: which timestamp field or header, in what
  units, and with what tolerance?**  
  Use the body field `webhookTimestamp`. The schema types it `Float!`: "Unix
  timestamp in milliseconds when the webhook was sent." It is part of the signed
  body. A `Linear-Timestamp` header (also Unix ms) exists too, but the SDK
  treats it as legacy and ignores it. SDK 95.0.0 changelog (2cddc35): "Require a
  finite numeric `webhookTimestamp` in the signed body and enforce the existing
  one-minute replay window ... Unsigned timestamp headers and legacy timestamp
  arguments can no longer bypass this check. The optional third argument to
  `verify()` and `parseData()` is ... ignored." SDK 85.0.0 (7f440a4) fixed a
  replay bypass in which the header could override the body. Tolerance: the SDK
  rejects when |Date.now() - webhookTimestamp| > 60,000 ms, in either direction.
  The official docs also recommend checking that the timestamp is within one
  minute.  
  _Source (changelog, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/CHANGELOG.md
  _Verifier:_ CONFIRMED. `webhookTimestamp: Float!` ("Unix timestamp in
  milliseconds when the webhook was sent") is present on EntityWebhookPayload,
  BaseWebhookPayload, IssueSlaWebhookPayload, OAuthAppWebhookPayload and
  OAuthAuthorizationWebhookPayload. Changelog entry 2cddc35 sits under the
  `## 95.0.0` heading; npm shows 95.0.0 published 2026-09-09. Entry 7f440a4 (the
  header-overrides-body replay bypass fix) sits under `## 85.0.0` (published
  2026-05-21). The SDK rejects when |Date.now() - webhookTimestamp| > 60000 ms
  in either direction. It reads the `linear-timestamp` header but `verify()`
  overwrites it with the body value. The official docs (search snippet) only
  RECOMMEND the check: "We recommend that…
  (https://raw.githubusercontent.com/linear/linear/master/packages/sdk/CHANGELOG.md)

- **Which HTTP headers does Linear send with each delivery?**  
  According to the official webhooks page (seen through search snippets):
  `Linear-Delivery` is a UUID v4 that identifies the payload. `Linear-Event` is
  the entity type, e.g. Issue or Comment. `Linear-Signature` is the hex
  HMAC-SHA256. `Linear-Timestamp` is Unix ms. `User-Agent` is `Linear-Webhook`.
  For deduplication use `Linear-Delivery`. The body field `webhookId` is "The ID
  of the webhook that sent this event" (schema). That is the webhook
  configuration's ID, which is the same on every delivery, so it cannot identify
  a delivery. Linear's own linear-solutions guide is wrong when it dedupes on
  `payload.webhookId`.  
  _Source (official-doc, medium):_ https://linear.app/developers/webhooks
  _Verifier:_ CONFIRMED, from search snippets only. My direct fetch of
  linear.app also failed (WebFetch ENOTFOUND, proxy 403). The
  developers/webhooks page lists `Linear-Delivery` (UUID v4 identifying the
  payload), `Linear-Event` (entity type), `Linear-Signature`, `Linear-Timestamp`
  (ms), and `User-Agent: Linear-Webhook`. The `webhookId` point is CONFIRMED by
  the schema: "The ID of the webhook that sent this event" is the webhook
  configuration ID, so deduplicating on it, as the linear-solutions guide does
  at README L286-296, is wrong. CAVEAT: nothing documents whether
  `Linear-Delivery` stays the same across retries. The only identifier
  documented as "stable across retries of the same payload" is `Webhook…
  (https://linear.app/developers/webhooks)

- **3. What is the payload shape (top-level fields)?**  
  `EntityWebhookPayload` (schema) has these fields: `action: String!`,
  `actor: EntityActorWebhookPayload` (a union of UserActor, OauthClientActor,
  IntegrationActor and ExternalUserActor), `createdAt: DateTime!`,
  `data: DataWebhookPayload!` (the entity), `organizationId: String!`,
  `type: String!` (the entity name), `updatedFrom: JSONObject` ("In case of an
  update event, previous values of all updated properties"), `url: String`
  (nullable), `webhookId: String!` and `webhookTimestamp: Float!` (ms).
  Non-entity payloads have different shapes. IssueSLA (`IssueSlaWebhookPayload`)
  carries `issueData` instead of `data`, and has no `actor` or `updatedFrom`.
  OAuthApp (`OAuthAppWebhookPayload`) carries `oauthClientId` and no `data`.
  AppUserNotification carries `notification`. All of them share
  `BaseWebhookPayload`: createdAt, organizationId, webhookId, webhookTimestamp.
  Per the Linear changelog, the …  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED from the schema. EntityWebhookPayload has action
  String!, actor EntityActorWebhookPayload (union of ExternalUserActor,
  IntegrationActor, OauthClientActor and UserActor), createdAt DateTime!, data
  DataWebhookPayload!, organizationId String!, type String!, updatedFrom
  JSONObject, url String, webhookId String! and webhookTimestamp Float!.
  BaseWebhookPayload has createdAt, organizationId, webhookId and
  webhookTimestamp. IssueSlaWebhookPayload has action, createdAt, issueData:
  IssueWebhookPayload!, organizationId, type, url, webhookId and
  webhookTimestamp, with no actor or updatedFrom. OAuthAppWebhookPayload has
  action, createdAt, oauthClientId ("Id of the OAuth client that was revoked…
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/schema.graphql)

- **What are the action values?**  
  Entity webhooks document `create`, `update` and `remove` (official docs, and
  Linear's linear-solutions guide, which says `remove` means "Resource was
  deleted/archived"). In the schema `action` is a plain `String!`, not an enum.
  I found no documented `restore` action. Non-entity webhooks use other strings.
  OAuthApp has a 'revoked' event: the schema says "Id of the OAuth client that
  was revoked", and the docs call it "OAuthApp revoked". According to a
  third-party guide, IssueSLA uses values like set, highRisk and breached; that
  guide is not official. How archive and unarchive are delivered (remove versus
  an update with archivedAt or trashed set) is not confirmed.  
  _Source (official-doc, medium):_
  https://github.com/linear/linear-solutions/blob/main/integration_guides/scenarios/03-webhooks/README.md
  _Verifier:_ The values are CONFIRMED: create, update and remove. A docs
  snippet says "The action field is one of create, update or remove", and the
  schema types `action` as plain `String!`. CORRECTED source_kind:
  github.com/linear/linear-solutions is a Linear-owned repo of sample guides,
  not the official docs. Its claims that `remove` means "Resource was
  deleted/archived" (README L74), that there are no retries on 4xx (L280), and
  that you should dedupe on webhookId (L286) are all unsupported or contradicted
  by the official docs and the schema. How archive and unarchive are delivered
  is UNVERIFIABLE. IssueWebhookPayload has `archivedAt`, `trashed` and
  `autoArchivedAt`, so archive probably arrives as an …
  (https://linear.app/developers/webhooks)

- **4. What are the supported webhook resource types, with exact type
  strings?**  
  The schema's `enum WebhookResourceType`, "A webhook event stream resource type
  that an OAuth application can subscribe to", contains: AgentSessionEvent,
  AppUserNotification, Attachment, Comment, Customer, CustomerNeed, Cycle,
  Document, Initiative, InitiativeUpdate, Issue, IssueLabel, IssueSLA,
  OAuthAuthorization, PermissionChange, Project, ProjectLabel, ProjectUpdate,
  Reaction, Release, ReleaseNote, User. The SDK's `LinearWebhookEventType`
  (payload `type` strings) is: Attachment, AuditEntry, Comment, Customer,
  CustomerNeed, Cycle, Document, Initiative, InitiativeUpdate, Issue,
  IssueLabel, Project, ProjectUpdate, Reaction, User, IssueSLA, OAuthApp,
  AppUserNotification, PermissionChange, AgentSessionEvent. You subscribe with
  `OAuthAuthorization`, but the payload `type` is `OAuthApp`. AuditEntry comes
  from the audit-log stream. The types this app asked about are exactly "Issue",
  "Project",…  
  _Source (source-code, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/webhooks/types.ts
  _Verifier:_ Both lists are CONFIRMED verbatim. The `WebhookResourceType` enum
  has 22 values: AgentSessionEvent, AppUserNotification, Attachment, Comment,
  Customer, CustomerNeed, Cycle, Document, Initiative, InitiativeUpdate, Issue,
  IssueLabel, IssueSLA, OAuthAuthorization, PermissionChange, Project,
  ProjectLabel, ProjectUpdate, Reaction, Release, ReleaseNote, User. The SDK's
  `LinearWebhookEventType` (types.ts L44-64) has 20 values. CORRECTED: the claim
  "you subscribe with OAuthAuthorization, but the payload type is OAuthApp" is
  not supported. The schema has a separate `OAuthAuthorizationWebhookPayload`
  with action, activeTokensForUser, oauthClient, oauthClientId, user, userId,
  type and others; it is di…
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/webhooks/types.ts)

- **Is there a ProjectMilestone webhook?**  
  No. `ProjectMilestone` does not appear in `WebhookResourceType`, in the
  `DataWebhookPayload` union, in the SDK's `LinearWebhookEventType`, or in the
  official list of data-change models. Milestone data arrives only embedded in
  other payloads. The Issue payload has `projectMilestoneId` and
  `projectMilestone: ProjectMilestoneChildWebhookPayload {id, name, targetDate}`;
  the older `milestone` field is deprecated in favour of `projectMilestone`. The
  Project payload has `milestones: [ProjectMilestoneChildWebhookPayload!]`, each
  `{id, name, targetDate}`. A milestone moving between issues therefore shows up
  as an Issue `update` with `updatedFrom.projectMilestoneId`. I could not
  confirm whether creating, editing or deleting a milestone fires a Project
  `update` webhook.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED: there is none. No milestone value appears in
  WebhookResourceType or DataWebhookPayload, and the only milestone-related
  webhook type in the whole schema is
  `ProjectMilestoneChildWebhookPayload {id: String!, name: String!, targetDate: String!}`.
  IssueWebhookPayload has `projectMilestoneId: String`,
  `projectMilestone: ProjectMilestoneChildWebhookPayload`, and `milestone`
  marked `@deprecated(reason: "Use projectMilestone instead.")`.
  ProjectWebhookPayload has
  `milestones: [ProjectMilestoneChildWebhookPayload!]`. New detail: the webhook
  child type declares `targetDate: String!` as non-null, but the API type
  `ProjectMilestone.targetDate` is a nullable `TimelessDate`. Expect null or
  mis…
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/schema.graphql)

- **Are IssueRelation (blocks / blocked-by / related) changes delivered by
  webhook?**  
  There is no official IssueRelation webhook type. It is absent from
  `WebhookResourceType`, `DataWebhookPayload`, the SDK event types and the docs'
  model list. `IssueWebhookPayload` has no relations fields; it does have
  parentId, labelIds, projectMilestoneId and similar, but nothing for relations.
  One third-party site (hookbase.app) lists an "IssueRelation" event, but
  nothing official backs it. Whether a relation change bumps the Issue and emits
  an Issue `update` is unconfirmed. Plan on GraphQL polling or reconciliation
  for dependency changes.  
  _Source (schema-file, medium):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED that no webhook type exists. I listed every
  `*WebhookPayload` type in the schema (about 85) and none is relation-related.
  IssueWebhookPayload has no relations field: it has parentId, labelIds,
  projectMilestoneId and the like, nothing for relations. The developer docs'
  model list (search snippet) also leaves relations out. Whether adding or
  removing a relation emits an Issue `update` is UNVERIFIABLE; it needs a live
  test. Plan to reconcile relations by polling GraphQL.
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/schema.graphql)

- **5a. How are webhooks configured for an OAuth application?**  
  You configure them on the OAuth app itself. The schema fields are
  `OAuthApplication.webhookEnabled: Boolean!`, `webhookUrl: String` and
  `webhookResourceTypes: [WebhookResourceType!]!`. The create and update inputs
  take `webhookResourceTypes` and `webhookUrl`. In the UI this lives in the
  app's settings under Settings > Administration > API. Official docs (via
  search): "each time a new organization authorizes the given application, a
  webhook will be created for that organization that posts to the provided
  webhook URL." So one URL receives events from every installing workspace; tell
  them apart by `organizationId`. The schema adds that `Webhook.url` is "Null
  for OAuth application webhooks, which use the webhook URL configured on the
  OAuth client instead." Per the changelog, existing installs must re-authorize
  the app before deliveries start if webhooks were enabled after they
  installed.  
  _Source (schema-file, medium):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ The schema part is CONFIRMED:
  `OAuthApplication.webhookEnabled: Boolean!`,
  `webhookResourceTypes: [WebhookResourceType!]!` and `webhookUrl: String`
  ("Null if not set"), with matching optional fields on
  OAuthApplicationCreateInput and OAuthApplicationUpdateInput. `Webhook.url`
  reads "Null for OAuth application webhooks, which use the webhook URL
  configured on the OAuth client instead." The docs quote "each time a new
  organization authorizes the given application, a webhook will be created for
  that organization that posts to the provided webhook URL" is confirmed via
  search snippet; route events by `organizationId`. The re-authorization claim
  is PARTIALLY SUPPORTED. A linear.app changelog sni…
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/schema.graphql)

- **5b. How are workspace webhooks created through the API, and what permissions
  does that need?**  
  Mutation: `webhookCreate(input: WebhookCreateInput!): WebhookPayload!`,
  described as "Creates a new webhook subscription for the workspace. Requires
  specifying a URL, resource types to subscribe to, and either a specific team
  or all public teams." Input fields: `url: String!`,
  `resourceTypes: [String!]!`, `teamId`, `allPublicTeams`, `label`, `secret`
  (auto-generated if omitted), `enabled` (default true) and `id`. The response
  returns `webhook { id secret ... }`. Related mutations: webhookUpdate,
  webhookDelete and webhookRotateSecret. Permissions per the official docs: only
  workspace admins, or OAuth apps with the `admin` scope, can create or read
  webhooks. Product docs: "Creating and managing webhooks requires admin
  permissions", and webhooks for private teams "can be set up by team owners and
  workspace admins." In the UI this is Settings > Administration > API. The
  changelog mentions q…  
  _Source (official-doc, medium):_ https://linear.app/docs/api-and-webhooks
  _Verifier:_ CONFIRMED.
  `webhookCreate(input: WebhookCreateInput!): WebhookPayload!` is described as
  "Creates a new webhook subscription for the workspace. Requires specifying a
  URL, resource types to subscribe to, and either a specific team or all public
  teams." Input fields: allPublicTeams, enabled (= true), id (UUID v4), label,
  resourceTypes: [String!]!, secret, teamId, url: String!. `WebhookPayload`
  returns `webhook: Webhook!`, which includes `secret`. `WebhookUpdateInput` has
  only enabled, label, resourceTypes, secret and url. There is no teamId or
  allPublicTeams, so the scope cannot be changed after creation. Permissions are
  confirmed by Linear's own doc search on linear.app/docs/api-and-webhooks:…
  (https://linear.app/docs/api-and-webhooks)

- **6a. What are the delivery semantics: response requirements, timeout and
  retries?**  
  Official webhooks page (via search snippets; a direct fetch failed): the
  receiver must be a public HTTPS URL and must answer with HTTP 200. A delivery
  fails if the server is unavailable, takes longer than 5 seconds to respond, or
  returns a non-200 status. Failed deliveries are retried at most 3 times, after
  1 minute, 1 hour and then 6 hours. If the URL stays unresponsive, Linear may
  disable the webhook, and someone has to re-enable it manually. The schema adds
  `WebhookFailureEvent.executionId`, "stable across retries of the same
  payload", and `Webhook.failures` ([INTERNAL], last 50). Linear's
  linear-solutions guide claims there are no retries on 4xx, which contradicts
  the official 'non-200 = failure' wording. Unresolved.  
  _Source (official-doc, medium):_ https://linear.app/developers/webhooks
  _Verifier:_ CONFIRMED, from a search snippet that quotes the developer docs
  verbatim: "If a delivery fails (i.e. server unavailable, takes longer than 5
  seconds (5000ms) to respond, or responds with a non-200 HTTP status code), the
  push will be retried a maximum of 3 times. A backoff delay is used: the
  attempt will be retried after 1 minute, 1 hour, and finally after 6 hours."
  Also: "If the webhook URL continues to be unresponsive the webhook might be
  disabled by Linear, and must be re-enabled again manually." Snippets also say
  the docs' own example returns 500 on handler failure so Linear retries.
  Schema: `WebhookFailureEvent` has executionId ("remains the same across
  retries of the same payload"), ht… (https://linear.app/developers/webhooks)

- **6b. Which IP addresses does Linear send from?**  
  The official Security page says Linear "currently uses the following source IP
  addresses for all outbound traffic (webhooks, integrations, etc.)":
  34.134.222.122, 34.140.253.14, 34.185.239.137, 34.186.126.124, 34.38.87.206,
  34.48.40.158, 34.60.255.158, 34.62.119.29, 35.196.141.51, 35.222.25.142,
  35.231.147.226, 35.236.218.67, 35.243.134.228, 35.246.206.27, 35.246.210.220.
  A machine-readable list is at
  https://linear.app/.well-known/appspecific/app.linear.ips.json, which Linear
  aims to update four weeks before using new IPs. A September 2026 changelog
  entry announced new outbound webhook IPs going live within weeks. Linear's
  guidance is to rely on signature verification rather than IP checks. I got the
  list through the Linear docs search tool and could not fetch the JSON file
  directly from the sandbox.  
  _Source (official-doc, medium):_ https://linear.app/docs/security _Verifier:_
  CONFIRMED verbatim through Linear's own documentation search tool (mcp Linear
  search_documentation, page linear.app/docs/security). All 15 IPs match
  exactly: 34.134.222.122, 34.140.253.14, 34.185.239.137, 34.186.126.124,
  34.38.87.206, 34.48.40.158, 34.60.255.158, 34.62.119.29, 35.196.141.51,
  35.222.25.142, 35.231.147.226, 35.236.218.67, 35.243.134.228, 35.246.206.27,
  35.246.210.220. The JSON at
  https://linear.app/.well-known/appspecific/app.linear.ips.json is updated
  "four weeks in advance of using any new outbound IPs". I could not fetch it
  (proxy 403). The "September 2026" date for the new-IPs changelog entry is
  UNVERIFIABLE. I saw the text "Added new outbound IPs for webhooks, which will…
  (https://linear.app/docs/security)

- **How does the SDK webhook helper work with Next.js?**  
  `@linear/sdk` 98.0.0 is the npm latest, published 2026-10-15. Import with
  `import { LinearWebhookClient } from "@linear/sdk/webhooks"` (exports map
  entry `./webhooks`); the root `@linear/sdk` also re-exports it.
  `new LinearWebhookClient(secret)` throws on an empty secret.
  `client.createHandler({ maxBodyBytes? })` returns a function that takes a
  Fetch `Request` and returns a `Response`, so a Next.js App Router route
  handler can use it directly. It also accepts a Node
  `(IncomingMessage, ServerResponse)` pair. Its behaviour: 405 for anything
  other than POST, 400 if the signature is missing or invalid or the timestamp
  is stale, 413 for bodies over 5 MiB (default), and 500 if a handler throws. It
  responds 200 only after `await Promise.all(handlers)`, so slow handlers run
  into Linear's 5-second timeout. `handler.on(type, fn)`, `on('*')`, `off` and
  `removeAllListeners` dispatch by payload
  `typ…   _Source (source-code, high):_ https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/webhooks/client.ts _Verifier:_ CONFIRMED. npm dist-tags show latest = 98.0.0, published 2026-10-15T23:30:06Z. The exports map has `./webhooks`-> ./dist/webhooks/index.mjs. The root index.mjs re-exports LinearWebhookClient and also keeps a deprecated alias`LinearWebhooks`.
  The constructor throws TypeError on an empty or non-string secret.
  createHandler supports both a Fetch Request and a Node (IncomingMessage,
  ServerResponse) pair. Exact responses: 405 "Method not allowed"; 400 "Missing
  webhook signature", checked before the body is read; 413 "Payload too large"
  on content-length or streamed size; 400 "Invalid webhook" for malformed JSON,
  a bad signature, or a missing or stale timestamp; 500 if a handler throws; 200
  "OK…
  (https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/package.json)

- **Is webhookTimestamp regenerated on retries?**  
  Probably yes, but this is not documented. Retries arrive 1 minute to 6 hours
  after the first attempt, and the official SDK rejects anything older than 60
  seconds. If the timestamp were not regenerated, every retry would fail
  verification. Together with the schema text "Unix timestamp in milliseconds
  when the webhook was sent", that implies Linear re-stamps and re-signs each
  attempt. Unverified; confirm with a live test.  
  _Source (inferred, low):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ UNVERIFIABLE. No official source says. A third-party PR
  (github.com/nuphos/nuphos/pull/460) also notes that Linear's docs don't
  describe how timestamps behave on retries. The inference holds up as reasoning
  but stays unconfirmed: the retries at 1 min, 1 h and 6 h would always fail the
  SDK's 60 s window unless Linear re-stamps and re-signs each attempt. Needs a
  live test: return 500 once and log webhookTimestamp and Linear-Delivery on the
  retry. (https://linear.app/developers/webhooks)

### Added by the verifier

- **[ADDED] Do allPublicTeams webhooks receive events from private teams?**  
  No. The schema says `Webhook.allPublicTeams` means "receives events from all
  public (non-private) teams in the organization, including teams created after
  the webhook was set up". `Webhook.team` notes "When null, the webhook either
  targets all public teams (if allPublicTeams is true), multiple specific teams
  (if teamIds is set), or organization-wide events." Private-team data therefore
  needs its own team-scoped webhook, which team owners or workspace admins can
  create (linear.app/docs/private-teams). Whether a team-scoped webhook also
  receives workspace-level entities such as Initiative, User, or cross-team
  Project events is unverified.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/67791e535db585eedc5c7b7805f43d4e8af5d2b9/packages/sdk/src/schema.graphql

### Open questions

- I could not fetch https://linear.app/developers/webhooks directly: WebFetch
  got ENOTFOUND for linear.app and the sandbox proxy refused the tunnel. The
  headers, the 5-second timeout, the retry schedule and the admin-scope wording
  come from search-result snippets of that page. Re-check them against the live
  page before treating them as contractual.
- Does creating, editing or deleting a project milestone fire a `Project`
  `update` webhook, for example with `updatedFrom.milestones`? This needs a live
  test.
- Does adding or removing an issue relation (blocks, blocked-by, related) emit
  any webhook, such as an `Issue` `update`? Probably not, but it needs a live
  test. A third-party site claims an 'IssueRelation' event type that the
  official schema does not list.
- Does `webhookCreate` reject resourceTypes strings outside the
  WebhookResourceType enum, such as 'ProjectMilestone' or 'IssueRelation'?
  `Webhook.resourceTypes` is typed `[String!]`, so try it once against a test
  workspace.
- Archive and unarchive delivery: does archiving send `remove`, or `update` with
  archivedAt or trashed set? Does unarchive or restore send `create` or
  `update`? No `restore` action is documented.
- Retry on 4xx: the official docs treat any non-200 as a failure, while Linear's
  linear-solutions guide says 4xx is not retried. Unresolved.
- Is the OAuth app's webhook signing secret shared across all installing
  workspaces? The schema puts it at app level, but no doc says so explicitly.
- The changelog mentions quotas of 30 webhooks per team and 50 per workspace. I
  saw this only in a search summary.
- The relayed user request says 'Look at the analytics repo for ui'. This
  subtask, Linear webhooks research, does not cover that; the orchestrator
  should handle it in a separate step.
- The developer docs page (linear.app/developers/webhooks) still has not been
  fetched directly. WebFetch got ENOTFOUND and the sandbox proxy returned 403
  for linear.app and web.archive.org. The headers, the 5 s timeout, the 1 min /
  1 h / 6 h retries and the admin-scope wording all come from search-engine
  snippets that quote it.
- Is `Linear-Delivery` the same on every retry of one payload? Linear documents
  only `WebhookFailureEvent.executionId` as stable across retries, and that is
  not sent in deliveries.
- Is `webhookTimestamp` re-stamped and re-signed on each retry? If not, the
  official SDK rejects every retry with 400.
- When you subscribe to `OAuthAuthorization`, which `type` string arrives:
  'OAuthAuthorization' (OAuthAuthorizationWebhookPayload) or 'OAuthApp'? The
  schema has two distinct payload types.
- Does a team-scoped webhook (teamId) receive workspace-level entities such as
  Initiative, User, or Projects that span several teams? Or do those need
  allPublicTeams=true or an OAuth app webhook?
- Does archive or unarchive arrive as `remove` or as an `update` that changes
  archivedAt or trashed? Does creating, editing or deleting a milestone fire a
  Project `update`? Do issue relation changes emit an Issue `update`? All three
  need a live test.
- Can `webhookCreate` be given resourceTypes strings outside the enum, given
  that `resourceTypes` is `[String!]!`?
- Is one OAuth app webhook signing secret used for every installing workspace?
  Under what conditions must existing installations re-authorize?
- Exact dates of the changelog entries for the webhook quotas (reportedly
  2026-10-08, 30 per team and 50 per workspace) and the new outbound IPs.
- Out of scope for this step: the relayed user request says 'Okay I just added
  it. Look at the analytics repo for ui'. This fact-check does not touch that.
  The orchestrator should handle it, likely by attaching or cloning the
  analytics repo, in a separate step.

## Linear GraphQL schema

- **Where did the current Linear SDL come from, and how big is it?**  
  I downloaded
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  (HTTP 200) and saved it as
  /tmp/claude-0/-home-user-Better-Tracker/d78b9b8a-94e3-52e5-bc60-de22b25cbe8a/scratchpad/linear-schema.graphql.
  It is 1,352,803 bytes and 53,325 lines, sha256
  3a98f6dcca0140d7d50c3989dbcf8fb73485714f7ef2345e31044fd9d3775f0e. master is
  the repo's default branch (git ls-remote shows HEAD -> refs/heads/master at
  67791e5). master's packages/sdk/package.json has version 98.0.0, and the file
  is byte-identical (cmp) to the file at tag @linear/sdk@98.0.0. A pinned,
  reproducible URL is
  https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql.
  graphql-js 17.0.2 (already in the project's node_modules) builds a schema from
  it with buildSchema: 1,322 types. A sample query and mutation covering every
  field below passed validation.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED, with one nuance. I downloaded the file again from both
  master and the tag. Both are HTTP 200, 1,352,803 bytes, 53,325 lines, sha256
  3a98f6dc...5f0e. master and the tag are byte-identical, and the scratchpad
  copy has the same hash. - git ls-remote: HEAD -> refs/heads/master at
  67791e535db5. - Tag @linear/sdk@98.0.0 points to commit 9dd2ed80. It is a
  different commit from master, but the file is identical. - master's
  packages/sdk/package.json says version 98.0.0. - buildSchema with graphql
  17.0.2 succeeds. getTypeMap() returns 1,322 types, but that count includes
  graphql's built-in introspection (__*) types; there are 1,314 without them. -
  graphql-js is not hoisted into the project…
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Is the 'main' branch schema usable?**  
  No. The branch 'main' also returns HTTP 200, but it is stale: 885,053 bytes,
  its package.json says SDK version 75.0.0, and it has no Subscription root. Do
  not use it.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/main/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED that it is not usable. - main returns HTTP 200 with
  885,053 bytes, sha256 cba38501.... - Its packages/sdk/package.json says
  version 75.0.0. - grep finds 0 matches for '^type Subscription' on main and 1
  on master. - main is at commit 4d9cdbf, while master is at 67791e5.
  (https://raw.githubusercontent.com/linear/linear/main/packages/sdk/src/schema.graphql)

- **Does the npm package @linear/sdk ship schema.graphql or an introspection
  JSON?**  
  No. The latest version is @linear/sdk 98.0.0, published 2026-10-15T23:30:06Z;
  earlier ones were 97.2.0 on 2026-10-14 and 97.1.0 on 2026-10-07. The tarball
  has 11 files (unpacked 8.68 MB): README.md, LICENSE, package.json,
  webhooks/package.json, dist/index.mjs, dist/index.d.mts,
  dist/index-D2pH4Pk9.d.mts, dist/chunk-_.mjs, dist/webhooks-_.mjs and
  dist/webhooks/index.{mjs,d.mts}. package.json 'files' is [webhooks, dist,
  README.md]. There is no .graphql file and no introspection JSON: grep for
  __schema or 'type Query {' in dist finds nothing. Tests therefore cannot load
  the SDL from node_modules. Either vendor the file (pinned to the SDK tag) or
  validate against the SDK's generated TypeScript types or documents. The
  packages @linear/schema and @linear/graphql-schema do not exist on npm.  
  _Source (source-code, high):_
  https://registry.npmjs.org/@linear/sdk/-/sdk-98.0.0.tgz _Verifier:_ CONFIRMED
  that it ships neither. - dist-tags.latest is 98.0.0. Publish times: 98.0.0 at
  2026-10-15T23:30:06.543Z, 97.2.0 at 2026-10-14T03:32, 97.1.0 at
  2026-10-07T19:47. - The registry reports fileCount 11 and unpackedSize
  8,683,070. - The tarball lists exactly the 11 files described, and
  package.json files is [webhooks, dist, README.md]. - grep for '__schema' or
  'type Query {' over the extracted package finds nothing. - The registry
  returns 404 for both @linear/schema and @linear/graphql-schema.
  (https://registry.npmjs.org/@linear/sdk/-/sdk-98.0.0.tgz)

- **Issue: the requested fields and their types**  
  type Issue implements Node has: - id: ID! - identifier: String! (e.g.
  ENG-123) - title: String! - url: String! - priority: Float! ('0 = No priority,
  1 = Urgent, 2 = High, 3 = Medium, 4 = Low'). It is Float on Issue, but
  IssueUpdateInput.priority is Int. priorityLabel: String! also exists. -
  createdAt: DateTime!; updatedAt: DateTime! ('last time at which the entity was
  meaningfully updated') - startedAt, completedAt, canceledAt, archivedAt:
  DateTime (nullable) - trashed: Boolean (nullable) - assignee: User (nullable);
  state: WorkflowState!; team: Team!; project: Project (nullable);
  projectMilestone: ProjectMilestone (nullable) - relations(after, before,
  first, includeArchived, last, orderBy): IssueRelationConnection! -
  inverseRelations(same args): IssueRelationConnection! - history(after, before,
  first, includeArchived, last, orderBy): IssueHistoryConnection! Also useful:
  stateHistory(af…  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. Every listed field has the stated type. - priority:
  Float!, and IssueUpdateInput.priority: Int. - stateHistory takes (after,
  before, first, last) only: no orderBy and no includeArchived. - relations,
  inverseRelations and history take (after, before, first, includeArchived,
  last, orderBy). - Issue has no stateChangedAt or stateUpdatedAt field.
  Additional notes: - Issue.estimate is Float, but IssueUpdateInput.estimate is
  Int. - Issue.identifier is not stable. Linear's docs say moving an issue to
  another team generates a new issue ID, so store and key on Issue.id (the
  UUID), not on identifier.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql
  ; https://linear.app/docs/creating-issues)

- **IssueHistory: fromStateId, toStateId and createdAt**  
  IssueHistory has: - fromStateId: String ('Null if the status was not changed')
  and fromState: WorkflowState - toStateId: String and toState: WorkflowState -
  createdAt: DateTime! - also id, actor: User, actorId: String, issue: Issue!,
  fromAssigneeId/toAssigneeId, fromProjectId/toProjectId,
  fromProjectMilestone/toProjectMilestone (objects only, no Id fields),
  fromPriority/toPriority: Float, fromDueDate/toDueDate: TimelessDate,
  archived/trashed: Boolean, updatedAt. Issue.history accepts orderBy:
  PaginationOrderBy (createdAt|updatedAt). The SDL does not say whether the
  default is ascending or descending.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - fromStateId and toStateId are String. Their
  descriptions say 'Null if the status was not changed'. - fromState and toState
  are WorkflowState. - createdAt is DateTime!. - There are
  fromProjectId/toProjectId fields. fromProjectMilestone/toProjectMilestone
  exist only as objects, with no Id variants. - fromPriority and toPriority are
  Float. Additional fields worth knowing: - relationChanges:
  [IssueRelationHistoryPayload!] { identifier, type }, which records relation
  additions and removals in history. - changes: JSONObject [Internal]. - actors
  is deprecated in favour of actor. The default sort direction of history is not
  documented in the SDL; confirmed.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Is there a field giving the time of the issue's last state change?**  
  No scalar field exists on Issue: there is no stateChangedAt or stateUpdatedAt.
  (IssueSuggestion.stateChangedAt is unrelated.) You can get it three ways: -
  Issue.stateHistory: IssueStateSpanConnection! ('The issue's workflow states
  over time'), not marked Internal. IssueStateSpan has id: ID!, stateId: ID!,
  state: WorkflowState, startedAt: DateTime! ('when the issue entered this
  state') and endedAt: DateTime ('Null if the issue is currently in this
  state'). The span with endedAt == null gives the time of the last state change
  in its startedAt. - Issue.history entries where toStateId != null; take the
  max createdAt. - startedAt/completedAt/canceledAt cover only those state
  types. The IssueFilter and IssueSortInput field 'accumulatedStateUpdatedAt'
  exists but is marked [Internal]. The order of the stateHistory spans is not
  documented in the SDL, so do not assume last:1 returns the current s…  
  _Source (schema-file, medium):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - Issue has no stateChangedAt field. -
  Issue.stateHistory: IssueStateSpanConnection! ('The issue's workflow states
  over time') carries no [Internal] tag. - IssueStateSpan = { id: ID!, stateId:
  ID!, state: WorkflowState, startedAt: DateTime!, endedAt: DateTime ('Null if
  the issue is currently in this state') }. -
  IssueFilter.accumulatedStateUpdatedAt (NullableDateComparator) and
  IssueSortInput.accumulatedStateUpdatedAt (TimeInStatusSort) are both
  [Internal]. - stateHistory takes no orderBy, and the SDL does not document
  span order. The advice stands: pick the span with endedAt == null, and do not
  rely on position. I kept confidence at medium only because the order is
  undocumented …
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **IssueRelation: fields, IssueRelationType values, and what issue vs
  relatedIssue mean for 'blocks'**  
  type IssueRelation implements Node has: - id: ID! - type: String! (a plain
  String on the object, not the enum: 'Possible values include blocks,
  duplicate, and related') - issue: Issue! ('The source issue ... from which the
  relation originates') - relatedIssue: Issue! ('The target issue ... The
  relation type describes how the source issue relates to this issue') -
  createdAt, updatedAt, archivedAt enum IssueRelationType { blocks duplicate
  related similar }. There is no 'blocked_by' value. For type 'blocks', issue
  blocks relatedIssue: issue is the blocker and relatedIssue is the blocked one.
  An issue's 'Blocked by' list is therefore its inverseRelations with type ==
  'blocks', where the blocker is the inverse relation's .issue.
  IssueRelationCreateInput is { id?, issueId: String!, relatedIssueId: String!,
  type: IssueRelationType! }. IssueFilter has hasBlockedByRelations and
  hasBlockingRelati…  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  ; https://linear.app/docs/issue-relations _Verifier:_ CONFIRMED. -
  IssueRelation.type is String!. - issue is documented as 'The source issue ...
  from which the relation originates'. relatedIssue is documented as 'The target
  issue ... The relation type describes how the source issue relates to this
  issue'. - enum IssueRelationType { blocks duplicate related similar }. There
  is no blocked_by value, so for 'blocks', issue is the blocker and relatedIssue
  is the blocked issue. - IssueRelationCreateInput = { id?, issueId: String!,
  relatedIssueId: String!, type: IssueRelationType! }. Both ids accept a UUID or
  'LIN-123'. - IssueFilter.hasBlockedByRelations and hasBlockingRelations are
  RelationExistsComparator {eq, neq}. - The product docs at linear.ap…
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql
  ; https://linear.app/docs/issue-relations)

- **Project: the requested fields**  
  type Project implements Node has: - id: ID!, name: String!, url: String! -
  priority: Int! (0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low),
  priorityLabel: String! - prioritySortOrder: Float!, sortOrder: Float! - lead:
  User (nullable) - status: ProjectStatus! (current). state: String! is
  deprecated with @deprecated(reason: "Use project.status instead"). -
  targetDate: TimelessDate, startDate: TimelessDate (with targetDateResolution /
  startDateResolution: DateResolutionType) - startedAt, completedAt, canceledAt,
  archivedAt: DateTime; trashed: Boolean - teams(after, before, filter:
  TeamFilter, first, includeArchived, last, orderBy): TeamConnection! -
  initiatives(...): InitiativeConnection! - projectMilestones(after, before,
  filter: ProjectMilestoneFilter, first, includeArchived, last, orderBy):
  ProjectMilestoneConnection! - members(after, before, filter: UserFilter,
  first, inclu…  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - priority: Int!; status: ProjectStatus!. - state:
  String! is @deprecated('Use project.status instead'). - targetDate and
  startDate are TimelessDate. - teams, projectMilestones and members accept a
  filter argument. - initiatives has no filter argument; it takes (after,
  before, first, includeArchived, last, orderBy). - members also takes
  includeDisabled. - ProjectStatus has id, name, color, position, type:
  ProjectStatusType! and indefinite: Boolean!. - enum ProjectStatusType {
  backlog canceled completed paused planned started }. - health is
  ProjectUpdateHealthType { atRisk offTrack onTrack }. Additions: - enum
  DateResolutionType { halfYear month quarter year }. A project targetDat…
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **ProjectMilestone: the requested fields**  
  type ProjectMilestone implements Node has: - id: ID!, name: String! -
  description: String (markdown), documentContent: DocumentContent,
  descriptionState: String [Internal]. There is no descriptionData output field;
  descriptionData: JSONObject [Internal] exists only on
  ProjectMilestoneUpdateInput. - targetDate: TimelessDate (nullable). scalar
  TimelessDate is 'a date in ISO 8601 format', so send 'YYYY-MM-DD'; it also
  accepts shortcuts and ISO durations. - sortOrder: Float! - project: Project! -
  issues(after, before, filter: IssueFilter, first, includeArchived, last,
  orderBy): IssueConnection! - status: ProjectMilestoneStatus!, where enum
  ProjectMilestoneStatus { done next overdue unstarted } - progress: Float!
  ('The progress % of the project milestone'); currentProgress and
  progressHistory: JSONObject! [Internal] - createdAt, updatedAt, archivedAt  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - ProjectMilestone has id, name, description
  (markdown), documentContent and descriptionState [Internal]. There is no
  descriptionData output field. - targetDate is TimelessDate, sortOrder is
  Float!, project is Project!, and issues takes a filter. - status is
  ProjectMilestoneStatus { done next overdue unstarted }. - progress is Float!
  ('The progress % of the project milestone'). - currentProgress and
  progressHistory are JSONObject! [Internal]. - The TimelessDate scalar
  description says ISO 8601, accepts shortcuts like `2021`, and accepts
  durations like '-P2W1D'. - Whether progress uses a 0-1 or a 0-100 scale is not
  stated (see open questions).
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Initiative: the requested fields**  
  type Initiative implements Node has: - id: ID!, name: String!, sortOrder:
  Float! - priority: Int! (it exists: 0 = No priority ... 4 = Low),
  prioritySortOrder: Float! - status: InitiativeStatus!, where enum
  InitiativeStatus { Active Canceled Completed Planned Proposed } (PascalCase) -
  targetDate: TimelessDate, targetDateResolution - projects(after, before,
  filter: ProjectFilter, first, includeArchived, includeSubInitiatives: Boolean,
  last, orderBy, sort: [ProjectSortInput!]): ProjectConnection! - also owner:
  User, url: String!, slugId, startedAt, completedAt, archivedAt, trashed,
  parentInitiative, subInitiatives, updatedAt The root query
  initiativeToProjects gives all initiative-to-project links.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - priority: Int!; prioritySortOrder: Float!. - status:
  InitiativeStatus! with values { Active Canceled Completed Planned Proposed }
  in PascalCase. - projects(after, before, filter: ProjectFilter, first,
  includeArchived, includeSubInitiatives: Boolean, last, orderBy, sort:
  [ProjectSortInput!]). - owner, url, slugId, startedAt, completedAt,
  archivedAt, trashed, parentInitiative and subInitiatives all exist. - The root
  query initiativeToProjects(after, before, first, includeArchived, last,
  orderBy): InitiativeToProjectConnection! exists.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **User: the requested fields**  
  type User implements Node has: - id: ID!, name: String! (full name),
  displayName: String! (unique nick), email: String! - active: Boolean! (false =
  disabled or suspended), avatarUrl: String (nullable) - admin: Boolean!, guest:
  Boolean!, owner: Boolean!, isMe: Boolean!, app: Boolean! ('Whether the user is
  an app') - also isAssignable: Boolean!, timezone: String, url: String!,
  initials: String!, disableReason: String, archivedAt, updatedAt The root query
  users(...) has includeDisabled: Boolean. Disabled users are excluded unless it
  is set to true.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - Every listed field exists with the stated
  nullability. avatarUrl is the only nullable one among the core fields. - The
  includeDisabled argument is documented as 'Should query return
  disabled/suspended users (default: false)'.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **WorkflowState: the requested fields**  
  type WorkflowState implements Node has: - id: ID!, name: String! - type:
  String! (a String, not an enum): 'One of "triage", "backlog", "unstarted",
  "started", "completed", "canceled", "duplicate"' - position: Float!
  ('displayed in ascending order of position within their type group') - team:
  Team! - also color, description, inheritedFrom, archivedAt, updatedAt  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - type is String!, documented as 'One of "triage",
  "backlog", "unstarted", "started", "completed", "canceled", "duplicate"'. -
  position is Float!, with states 'displayed in ascending order of position
  within their type group'. - team is Team!. - WorkflowStateFilter.type is a
  StringComparator.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Organization and the viewer query**  
  type Organization implements Node has id: ID!, name: String! and urlKey:
  String! (plus many others). The root query has organization: Organization!
  ('The authenticated user's workspace') and viewer: User! ('The currently
  authenticated user'). viewer { organization { id name urlKey } } passes
  validation.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - Organization.id is ID!; name and urlKey are
  String!. - Query.organization is Organization!. - Query.viewer is User!. -
  viewer { organization { id name urlKey } } validated in my own query.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Root query connections for bulk fetch, and their arguments**  
  All return *Connection { edges, nodes, pageInfo { hasNextPage hasPreviousPage
  startCursor endCursor } }. - issues(after, before, filter: IssueFilter, first,
  includeArchived, last, orderBy: PaginationOrderBy, sort: [IssueSortInput!]) -
  projects(after, before, filter: ProjectFilter, first, includeArchived, last,
  orderBy, sort: [ProjectSortInput!]) - projectMilestones(after, before, filter:
  ProjectMilestoneFilter, first, includeArchived, last, orderBy) -
  initiatives(after, before, filter: InitiativeFilter, first, includeArchived,
  last, orderBy, sort: [InitiativeSortInput!]) - users(after, before, filter:
  UserFilter, first, includeArchived, includeDisabled, last, orderBy, sort:
  [UserSortInput!]) - teams(after, before, filter: TeamFilter, first,
  includeArchived, last, orderBy) - workflowStates(after, before, filter:
  WorkflowStateFilter, first, includeArchived, last, orderBy) -
  issueRelations…  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. Every argument list matches. - issueRelations and
  projectStatuses have no filter argument. - PaginationOrderBy is { createdAt
  updatedAt }. - The SDL has 403 occurrences of 'Defaults to 50'. -
  includeArchived is documented '(default: false)'. - ProjectFilter,
  InitiativeFilter, UserFilter, TeamFilter, WorkflowStateFilter and
  ProjectMilestoneFilter all have updatedAt: DateComparator. - Linear's
  pagination docs, via search snippet, say results are ordered by createdAt by
  default, and updatedAt gets the most recently updated. Neither the docs nor
  the SDL state the direction. - Community measurements against api.linear.app
  (brekkylab/backlot issues #418 and #471, 2026-10-03 and 2026-10…
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql
  ; https://github.com/brekkylab/backlot/issues/418)

- **IssueFilter fields for filtering by updatedAt and by project or
  projectMilestone**  
  IssueFilter has: - updatedAt: DateComparator {eq, neq, gt, gte, lt, lte, in,
  nin} of DateTimeOrDuration, e.g. {updatedAt:{gt:"2026-10-01T00:00:00Z"}} or a
  duration like '-P1D' - project: NullableProjectFilter (id:
  EntityIdentifierIDComparator, null: Boolean, status, updatedAt, ...) -
  projectMilestone: NullableProjectMilestoneFilter {id: IDComparator, name,
  targetDate, project, null: Boolean, and, or, createdAt, updatedAt} - also
  and/or: [IssueFilter!], team: TeamFilter, state: WorkflowStateFilter (type:
  StringComparator), assignee: NullableUserFilter,
  archivedAt/completedAt/canceledAt/startedAt: NullableDateComparator, priority:
  NullableNumberComparator, id: IssueIDComparator IDComparator = {eq, neq, in,
  nin}. Archived issues only come back with includeArchived: true.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - updatedAt: DateComparator {eq, gt, gte, in, lt, lte,
  neq, nin} over DateTimeOrDuration. - project: NullableProjectFilter (id:
  EntityIdentifierIDComparator, null, status, updatedAt). - projectMilestone:
  NullableProjectMilestoneFilter {and, createdAt, id: IDComparator, name, null,
  or, project, targetDate, updatedAt}. - and and or are [IssueFilter!]. team,
  state, assignee, archivedAt, completedAt, canceledAt, startedAt, priority
  (NullableNumberComparator) and id (IssueIDComparator) all exist. -
  IDComparator is {eq, in, neq, nin}.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **What is the maximum page size ('first' limit)?**  
  The default is 50. Both the SDL argument docs ('Defaults to 50') and Linear's
  2019 API changelog say so. The SDL does not state a maximum. I could not
  confirm a documented maximum (such as 250), because
  linear.app/developers/pagination could not be fetched: the sandbox proxy
  blocks it and WebFetch could not resolve linear.app. Web searches did not
  surface the number either. Treat 250 as unverified. Choose a page size of 50
  to 100 and keep the per-query complexity cap below in mind. Confirm the
  maximum empirically, or from the docs page, before relying on more than 100.  
  _Source (inferred, low):_ https://linear.app/developers/pagination _Verifier:_
  UNVERIFIABLE. - The default of 50 is CONFIRMED by the SDL argument docs. - No
  maximum appears in the SDL, the SDK 98.0.0 dist, or the shallow clones of
  linear/linear and linear-solutions. - linear.app and developers.linear.app are
  unreachable: the proxy returns CONNECT 403 and WebFetch gets ENOTFOUND. - Web
  searches find 250 only on third-party skill pages and on Shopify, not on
  Linear. - One third-party page says an oversized first fails on complexity,
  not on a fixed cap. - Keep the researcher's recommendation: use 50 to 100 and
  confirm empirically. (https://linear.app/developers/pagination)

- **Rate limits and complexity**  
  From Linear's rate-limiting page, seen through search-result snippets rather
  than a direct fetch: - API key: 2,500 requests per hour and 3,000,000
  complexity points per hour. Limits are per user, and different keys for the
  same user share the quota. - OAuth app: 5,000 requests per hour and 2,000,000
  points per hour, per user or app user. - Unauthenticated: 100,000 points per
  hour, per IP. - A single query is capped at 10,000 points; anything above is
  rejected. - Cost: each property 0.1 point, each object 1 point, and any
  connection multiplies its children's points by the pagination argument
  (default 50). Setting an explicit, small first on every nested connection is
  therefore essential. - Linear uses a leaky-bucket algorithm. - When rate
  limited, GraphQL requests return HTTP 400 with errors[].extensions.code
  'RATELIMITED'. - Workspace-level OAuth apps using actor authorization get
  limit…  
  _Source (official-doc, medium):_ https://linear.app/developers/rate-limiting
  _Verifier:_ PARTIALLY CONFIRMED, with one addition. - Request limits are
  confirmed from search snippets of the official page: API key 2,500/hour per
  user, OAuth app 5,000/hour per user or app user, and unauthenticated 600
  requests/hour per IP (the researcher left this out), using a leaky bucket. -
  The 10,000-point per-query cap and the cost model (0.1 per property, 1 per
  object, connections multiply by first or the default 50, rounded up) are
  consistent across sources. - API key complexity of 3,000,000/hour and
  unauthenticated 100,000/hour appear in a snippet attributed to the newer
  Linear page. An older Linear page said 250,000 and 10,000. Treat this as
  medium confidence. - OAuth complexity of 2,000,0…
  (https://linear.app/developers/rate-limiting ;
  https://registry.npmjs.org/@linear/sdk/-/sdk-98.0.0.tgz)

- **Mutation issueUpdate**  
  issueUpdate(id: String!, input: IssueUpdateInput!): IssuePayload!.
  IssuePayload = { success: Boolean!, issue: Issue (nullable), lastSyncId:
  Float! }. IssueUpdateInput fields: - assigneeId: String - stateId: String -
  projectId: String (accepts a UUID or 'P-LIN-123') - projectMilestoneId:
  String - priority: Int - title, description: String - dueDate: TimelessDate -
  estimate: Int - parentId, teamId, cycleId, delegateId: String - labelIds,
  addedLabelIds, removedLabelIds, subscriberIds: [String!] - sortOrder,
  prioritySortOrder, subIssueSortOrder: Float - trashed: Boolean
  issueBatchUpdate(ids: [UUID!]!, input: IssueUpdateInput!): IssueBatchPayload!
  { success, issues: [Issue!]!, lastSyncId } also exists.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - issueUpdate(id: String!, input: IssueUpdateInput!):
  IssuePayload! { success, issue: Issue (nullable), lastSyncId }. - Every listed
  input field exists. projectId accepts a UUID or 'P-LIN-123', and parentId
  accepts a UUID or 'LIN-123'. - estimate is Int and priority is Int. -
  issueBatchUpdate(ids: [UUID!]!, input: IssueUpdateInput!): IssueBatchPayload!
  { issues: [Issue!]!, lastSyncId, success }. - The input also has
  addedReleaseIds, releaseIds, slaType, snoozedUntilAt and some [Internal]
  fields.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Mutation commentCreate**  
  commentCreate(input: CommentCreateInput!): CommentPayload!. CommentPayload = {
  success: Boolean!, comment: Comment!, lastSyncId: Float! }. CommentCreateInput
  fields: - body: String (markdown) - issueId: String (UUID or 'LIN-123') -
  parentId: String - projectId, initiativeId, projectUpdateId: String - id:
  String - createdAt: DateTime - doNotSubscribeToIssue: Boolean - createAsUser:
  String and displayIconUrl: String (OAuth actor=app only) - quotedText:
  String - createOnSyncedSlackThread: Boolean - bodyData: JSON [Internal]
  Comment has id, body: String!, url: String!, issue, issueId, user, parent and
  createdAt.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - commentCreate(input: CommentCreateInput!):
  CommentPayload! { success, comment: Comment! (non-null), lastSyncId }. - Every
  listed input field exists. issueId accepts a UUID or 'LIN-123'. - createAsUser
  and displayIconUrl are documented as OAuth actor=app only. - Fields not listed
  by the researcher: documentContentId, initiativeUpdateId, postId and
  subscriberIds [INTERNAL]. - Comment has id, body: String!, url: String!,
  issue, issueId, user, parent and createdAt.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Mutation projectMilestoneUpdate**  
  projectMilestoneUpdate(id: String!, input: ProjectMilestoneUpdateInput!):
  ProjectMilestonePayload!. ProjectMilestonePayload = { success: Boolean!,
  projectMilestone: ProjectMilestone! (non-null), lastSyncId: Float! }.
  ProjectMilestoneUpdateInput fields: name: String, description: String,
  descriptionData: JSONObject [Internal], projectId: String, sortOrder: Float,
  targetDate: TimelessDate.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - projectMilestoneUpdate(id: String!, input:
  ProjectMilestoneUpdateInput!): ProjectMilestonePayload! { success,
  projectMilestone: ProjectMilestone! (non-null), lastSyncId }. - The input
  fields are exactly description, descriptionData [Internal], name, projectId,
  sortOrder and targetDate: TimelessDate.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Mutation projectUpdate**  
  projectUpdate(id: String!, input: ProjectUpdateInput!): ProjectPayload!.
  ProjectPayload = { success: Boolean!, project: Project (nullable), lastSyncId:
  Float! }. ProjectUpdateInput fields: - leadId: String - statusId: String (ID
  of a ProjectStatus) - name, description, content, icon, color: String -
  priority: Int, prioritySortOrder: Float, sortOrder: Float - startDate,
  targetDate: TimelessDate (with startDateResolution / targetDateResolution) -
  teamIds, memberIds, labelIds: [String!] - canceledAt, completedAt: DateTime
  Note the naming clash: the mutation 'projectUpdate' edits a project, while the
  type ProjectUpdate and projectUpdateCreate are project status posts.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - projectUpdate(id: String!, input:
  ProjectUpdateInput!): ProjectPayload! { success, project: Project (nullable),
  lastSyncId }. - Every listed input field exists, including leadId, statusId,
  priority: Int, startDate/targetDate: TimelessDate with their resolutions,
  teamIds, memberIds, labelIds, canceledAt, completedAt and trashed. - The
  naming clash with the ProjectUpdate type and projectUpdateCreate is confirmed.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

- **Team: minimal fields**  
  Team has id: ID!, key: String! (the issue identifier prefix), name: String!,
  displayName: String!, states(filter: WorkflowStateFilter, ...):
  WorkflowStateConnection!, members(...): UserConnection!, issues(...,
  includeSubTeams: Boolean = false), projects(...) and archivedAt. private:
  Boolean! is deprecated in favour of visibility.  
  _Source (schema-file, high):_
  https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
  _Verifier:_ CONFIRMED. - Team has id, key ('prefix in issue identifiers'),
  name, displayName, states(filter), members(filter, includeDisabled, sort),
  issues(..., includeSubTeams: Boolean = false) and projects(...,
  includeSubTeams, sort). - The raw SDL shows the includeSubTeams default as '=
  false' on Team.issues. - private: Boolean! is @deprecated('Use
  `Team.visibility` instead.'). - visibility is TeamVisibility { private public
  restricted }.
  (https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql)

### Added by the verifier

- **NEW: Can deletions be detected with updatedAt-based incremental sync?**  
  Not from the SDL alone (inferred). - issueRelationDelete(id) and
  projectMilestoneDelete(id) return DeletePayload { entityId, lastSyncId,
  success }. - issueDelete trashes the issue unless permanentlyDelete is set. -
  A deleted relation or milestone will not show up in an updatedAt > since
  filter. Whether it is visible with includeArchived: true is undocumented. -
  issueRelations has no filter, and the SDL has no IssueRelationWebhookPayload
  or ProjectMilestoneWebhookPayload type. It does have IssueWebhookPayload,
  ProjectWebhookPayload, InitiativeWebhookPayload and others. - Plan a periodic
  full reconcile of relations and milestones, or use
  IssueHistory.relationChanges, rather than relying only on incremental
  updatedAt sync.  
  _Source (inferred, medium):_
  https://raw.githubusercontent.com/linear/linear/%40linear/sdk%4098.0.0/packages/sdk/src/schema.graphql

- **NEW: Will a bulk issues query with nested relations, history and
  stateHistory fit the 10,000-point per-query cap?**  
  Probably not at first: 50 with nested pages of 10 to 20 (inferred from the
  documented cost model). - My validated sample estimates at roughly 200 to 250
  points per issue: relations(first:20) plus inverseRelations(first:20) at about
  80 each, history(first:10) at about 50, and stateHistory(first:10) at
  about 25. - At issues(first: 50), that is about 10,000 to 12,500 points, at or
  over the cap. - Use issues(first: 25) or smaller nested first values, or fetch
  history and stateHistory only for issues whose state changed. Read the
  X-Complexity header to calibrate.  
  _Source (inferred, medium):_ https://linear.app/developers/rate-limiting

- **NEW (issue page review, 2026-10-22): archived labels stay on issues.**
  Linear's labels page: "Archiving a label keeps it on any issues where it's
  been applied, but stops people from using that label moving forward." In the
  SDL, `Issue.labels(…, includeArchived: Boolean)` defaults to false and
  `IssueUpdateInput.labelIds` replaces the whole set, so an editor that reads
  the set without `includeArchived: true` and sends it back drops archived
  labels the person never touched. The same page: "Subteams can use labels
  inherited from their parent team" (the planner offers only the team's own and
  workspace labels; architecture §4.1).  
  _Source (verified, high):_ https://linear.app/docs/labels (via Linear's
  documentation search) and the vendored SDL.

### Open questions

- What is the documented maximum for first/last on Linear connections? 250 is
  commonly cited but unverified. linear.app/developers/pagination could not be
  fetched: the proxy returned 403 and WebFetch could not resolve linear.app.
- What order does Issue.stateHistory return spans in, and does the default order
  of Issue.history run ascending or descending by createdAt? The SDL does not
  document either.
- When a blocking issue is completed, does an IssueRelation of type 'blocks'
  change to 'related' in the API, or does only the UI show it under Related? The
  product docs say the relationship 'moves under Related'.
- The rate-limit numbers (2,500 requests and 3M points per hour for API keys;
  5,000 requests and 2M points for OAuth; 10,000 points per query; HTTP 400 with
  RATELIMITED) came from search-result snippets of
  linear.app/developers/rate-limiting, not a direct fetch. Re-check them when
  the docs are reachable, or read the X-RateLimit-* headers at runtime.
- What is the maximum first/last? It is still unverified. linear.app and
  developers.linear.app are blocked here: the proxy returns CONNECT 403 and
  WebFetch gets ENOTFOUND. Settle it with one live call using first: 250, or
  from the docs page.
- What is the OAuth app complexity budget (claimed 2,000,000 points per hour),
  and what is the exact HTTP status on rate limiting (claimed 400)? Neither
  appears in any snippet I found. The 3,000,000 points per hour for API keys
  appears in one snippet attributed to the current page, and older pages say
  250,000.
- What order does Issue.stateHistory return spans in? It takes no orderBy. And
  what is the direction of Issue.history? Community measurements show root
  issues and users come back newest first, but nested connections were not
  measured.
- Is ProjectMilestone.progress (described as 'progress %') on a 0-1 or a 0-100
  scale? Project.progress is defined as a ratio formula, which suggests 0-1, but
  this is unconfirmed.
- When a blocking issue is resolved, does the stored relation type change?
  issueRelationUpdate lets type be mutated, so a server-side flip is possible
  but unconfirmed.
- Does creating or deleting an IssueRelation bump Issue.updatedAt? If it does
  not, a sync that pulls relations nested under issues filtered by updatedAt
  will miss relation changes.
- Note: the relayed user message ('Look at the analytics repo for ui') is about
  a different subtask. This step only fact-checked the Linear schema findings,
  as the workflow assigned.

## Slack DM digests

- **Access note: how were the Slack docs checked?**  
  The sandbox and WebFetch could not reach docs.slack.dev or api.slack.com (DNS
  ENOTFOUND or proxy 403 CONNECT). Mirrors such as translate.goog, r.jina.ai and
  web.archive.org were also blocked. The docs.slack.dev pages were therefore
  read only through WebSearch result excerpts. Those were cross-checked against
  Slack's own SDK source on raw.githubusercontent.com (node-slack-sdk main,
  python-slack-sdk main, java-slack-sdk main), Slack's archived OpenAPI v2 spec
  (slackapi/slack-api-specs, version 1.7.0, old) and the community-scraped
  slack-ruby/slack-api-ref method JSON. The scraped JSON reflects current docs:
  it includes markdown_text, unfurl_app_links and /apis/web-api/rate-limits
  links.  
  _Source (inferred, high):_
  https://docs.slack.dev/reference/methods/chat.postMessage _Verifier:_
  CORRECTED: The access problem is real. From this sandbox, curl to
  docs.slack.dev and api.slack.com gets a proxy 403 on CONNECT, and WebFetch
  gets ENOTFOUND. But there is a better source than search excerpts. The
  slack-ruby/slack-api-ref repo has a docs.slack.dev/ folder. Its
  tasks/lib/docs/methods_downloader.rb downloads Slack's own machine-readable
  reference, https://docs.slack.dev/reference/methods.json and
  https://docs.slack.dev/reference/methods/{method}.json, unchanged
  (JSON.pretty_generate only). The repo HEAD is dated 2026-10-17, and the
  chat.postMessage file was last refreshed 2026-09-30. These files carry
  official scope, rate_limits tier, http_method, json_input_supported, errors a…
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/tasks/lib/docs/methods_downloader.rb)

- **Scope for users.lookupByEmail (bot token)**  
  Bot tokens need users:read.email. The method page lists users:read.email for
  bot and user tokens, and the users:read.email scope page lists
  users.lookupByEmail as its method. The OpenAPI spec security is
  ['users:read.email']. Custom bot users (legacy) cannot use this method.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/users.lookupByEmail _Verifier:_
  CONFIRMED: users:read.email. Slack's official reference JSON has scope
  {bot:['users:read.email'], user:['users:read.email']}, http_method GET and
  rate_limits t3. The 'Custom bot users cannot use this method' wording comes
  from a search excerpt of the official page. The generic error is_bot ('This
  method cannot be called by a legacy bot') is consistent with it.
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/users.lookupByEmail.json)

- **Does users:read.email also need users:read?**  
  Yes, request both. The users:read.email scope page (via search excerpt) says
  the scope must be requested at the same time as users:read. The 2016 changelog
  says the two must be requested together in the same authorization.
  users.lookupByEmail itself lists only users:read.email, but the app
  configuration should declare users:read plus users:read.email.  
  _Source (official-doc, medium):_
  https://docs.slack.dev/reference/scopes/users.read.email _Verifier:_ CONFIRMED
  (excerpt only): request both. A search excerpt of the official
  users:read.email scope page says 'This scope must be requested at the same
  time as users:read.' The 2016-11-10 changelog excerpt says 'You'll need to
  request both users:read and users:read.email while installing the app.' The
  method's own JSON lists only users:read.email. Declaring both in the manifest
  is correct. (https://docs.slack.dev/reference/scopes/users.read.email)

- **Scope for conversations.open (bot token)**  
  The bot-token scope list is channels:manage, groups:write, im:write,
  mpim:write; you need the one that matches the conversation type. A 1:1 DM
  needs im:write. The im:write scope page lists conversations.open as a
  supported method for Bot tokens.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/conversations.open _Verifier:_
  CONFIRMED: the official JSON has bot scopes
  ['channels:manage','groups:write','im:write','mpim:write']; a 1:1 DM uses
  im:write. It also has http_method POST, json_input_supported true, rate_limits
  t3 and slack_connect_workspaces_allowed true. The user-token scopes are
  channels:write, groups:write, im:write, mpim:write.
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/conversations.open.json)

- **Scope for chat.postMessage (bot token)**  
  chat:write. chat:write.public is only for posting to public channels the bot
  is not a member of, so a DM does not need it. chat:write.customize is only
  needed to override username or icon.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/chat.postMessage _Verifier:_
  CONFIRMED: the official JSON has scope {bot:['chat:write'],
  user:['chat:write']}, http_method POST, json_input_supported true and
  rate_limits t5. t5 is the Special tier: the same code appears on auth.test,
  chat.getPermalink and oauth.v2.access, which are all Special. The
  chat:write.public and chat:write.customize claims match the scope pages and
  are not needed for DMs.
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/chat.postMessage.json)

- **Can chat.postMessage be called with channel=<user ID> to DM a user?**  
  Yes. The chat.postMessage docs say: 'With the chat:write scope enabled, call
  chat.postMessage and pass a user's ID (U123456) as the value of channel to
  post to that user's App Home channel. You can use their direct message channel
  ID (as found with conversations.open, for instance) instead.' The older
  wording says a direct message conversation will be opened if one is not
  already open. The message lands in the app's Messages tab of App Home, which
  is the bot-user DM. Posting by user ID needs only chat:write, not im:write.
  Because the response returns the DM channel ID ('D...') in its channel field,
  that ID can be cached. That last point is inferred from the standard response
  shape and was not re-verified in a live call.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/chat.postMessage _Verifier:_
  CONFIRMED, with one addition. A search excerpt of the official page has the
  exact sentence: 'With the chat:write scope enabled, call chat.postMessage and
  pass a user's ID ... as the value of channel to post to that user's App Home
  channel. You can use their direct message channel ID (as found with
  conversations.open, for instance) instead.' The same page also says: 'You will
  receive a channel_not_found error if your app doesn't have permission to enter
  into a DM with the intended user.' That makes channel_not_found the expected
  failure for an unreachable recipient. Do not request the legacy
  conversations.app_home:create scope that some search results surface; it
  belongs to deprecated worksp…
  (https://docs.slack.dev/reference/methods/chat.postMessage)

- **Does the App Home Messages tab need to be enabled?**  
  Yes. The chat.postMessage error list includes 'messages_tab_disabled: Messages
  tab for the app is disabled.' (from slack-ruby/slack-api-ref, which is scraped
  from the official docs). The manifest fields are
  features.app_home.messages_tab_enabled: true. messages_tab_read_only_enabled:
  true lets users read the DMs but not reply, which suits a notify-only bot. The
  App Home page says the Messages tab uses chat:write. You only need im:history
  plus the message.im event if the bot must respond to replies.  
  _Source (community, medium):_
  https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/methods/chat/chat.postMessage.json
  _Verifier:_ CONFIRMED (upgraded from community to official).
  messages_tab_disabled ('Messages tab for the app is disabled.') is in Slack's
  own chat.postMessage reference JSON, refreshed 2026-09-30, not only in the
  processed scrape. The manifest keys features.app_home.messages_tab_enabled and
  messages_tab_read_only_enabled are confirmed in @slack/web-api's manifest.ts
  and in the SchemaStore Slack manifest schema. Caveat: the official description
  of messages_tab_read_only_enabled is 'Whether or not the users can send
  messages to your app in the Messages tab', which is ambiguous about polarity.
  A Deno SDK doc excerpt says new apps are 'enabled and read-only by default',
  so true most likely means users can…
  (https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/web-api/src/types/request/manifest.ts)

- **Is conversations.open still recommended for DMs?**  
  No, it is optional. The docs present passing the user ID and passing a DM ID
  from conversations.open as equal options. conversations.open is useful if you
  want to resolve and store the D-channel ID up front, or to check for an
  existing DM with prevent_creation=true. Its arguments are users
  (comma-separated, 1 user gives a 1:1 DM, up to 8 users), channel (resume),
  return_im and prevent_creation. It is Tier 3 and needs im:write. For a daily
  digest the simplest option is chat.postMessage with channel=<user ID>, scope
  chat:write only.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/conversations.open _Verifier:_
  CONFIRMED: it is optional. The official JSON arguments are users
  (comma-separated; one user creates a 1:1 DM), channel (resume an im or mpim),
  return_im and prevent_creation (default false; 'used to see if there is an
  existing dm or mpdm'). The too_many_users error says 'Needs at most 8 users to
  open'. Tier t3, scope im:write. Success warnings are no_op and already_open,
  which means a call for an existing DM comes back ok:true with a warning, not
  an error.
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/conversations.open.json)

- **Base URL and auth header**  
  Base URL is https://slack.com/api/<method>; the node-slack-sdk WebClient
  default slackApiUrl is 'https://slack.com/api/'. Send the token as
  'Authorization: Bearer xoxb-...'. The SDK sets headers.Authorization =
  `Bearer ${token}`. For JSON bodies the docs require the token in the
  Authorization header; it cannot go in the query string or JSON body. For
  form-encoded POSTs the token may alternatively be a body field.  
  _Source (source-code, high):_
  https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/web-api/src/WebClient.ts
  _Verifier:_ CONFIRMED. In node-slack-sdk WebClient.ts the default is
  slackApiUrl='https://slack.com/api/', and it sets headers.Authorization =
  `Bearer ${token}`. The official reference JSON describes the token as: 'Tokens
  should be passed as an HTTP Authorization header or alternatively, as a POST
  parameter.' A search excerpt of the Web API page says that for JSON bodies
  'You must transmit your token as a bearer token in the Authorization HTTP
  header. You cannot send your token as part of the query string or as an
  attribute in your posted JSON.' It also says not to mix query-string, form and
  JSON arguments in one request.
  (https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/web-api/src/WebClient.ts)

- **Which methods accept JSON bodies and which need form or query encoding?**  
  The Web API docs say only write methods that support JSON accept it: 'For
  write methods that support JSON, you may alternatively send your HTTP POST
  data as Content-type: application/json. You must explicitly set the
  Content-type HTTP header to application/json.' The OpenAPI spec lists
  users.lookupByEmail as GET with consumes [application/x-www-form-urlencoded]
  only. conversations.open and chat.postMessage consume both form and JSON.
  python-slack-sdk calls users.lookupByEmail with http_verb='GET', params,
  conversations.open with params (form), and chat.postMessage with json=kwargs,
  sending Content-Type 'application/json;charset=utf-8'. node-slack-sdk sends
  every method, including chat.postMessage, as application/x-www-form-urlencoded
  with blocks JSON-stringified, so form encoding works everywhere. Recommended:
  GET https://slack.com/api/users.lookupByEmail?email=... with a Bearer
  header,…  
  _Source (official-doc, high):_ https://docs.slack.dev/apis/web-api/
  _Verifier:_ CONFIRMED. The official JSON gives users.lookupByEmail http_method
  GET with no json_input_supported flag, and chat.postMessage and
  conversations.open http_method POST with json_input_supported true.
  python-slack-sdk main makes the same calls: users.lookupByEmail with
  http_verb='GET' and params; conversations.open with params (form);
  chat.postMessage with json=kwargs, Content-Type
  'application/json;charset=utf-8'. node-slack-sdk sends
  'application/x-www-form-urlencoded' (WebClient.ts line ~756). The
  missing_charset warning is real: a search excerpt of the 2016-09-28 'response
  metadata is on the way' changelog shows its example warning for a Content-Type
  with no declared charset. Medium confi…
  (https://raw.githubusercontent.com/slackapi/python-slack-sdk/main/slack_sdk/web/client.py)

- **Response envelope**  
  Every response is a JSON object with top-level boolean ok. On failure, error
  holds a short machine-readable code. A call that succeeds with problems has
  ok: true plus warning, and newer responses also carry
  response_metadata.warnings. Errors come back with HTTP 200 and ok:false; the
  node SDK comments 'Slack's Web API doesn't use meaningful status codes besides
  429 and 200'. Always check body.ok, not only the HTTP status.  
  _Source (official-doc, high):_ https://docs.slack.dev/apis/web-api/
  _Verifier:_ CONFIRMED. The node SDK comment at WebClient.ts ~line 651 is
  verbatim: 'Slack's Web API doesn't use meaningful status codes besides 429 and
  200'. Any status other than 200 or 429 throws WebAPIHTTPError. The official
  JSON examples show {ok:false,error:'...'}. Warnings also come back on success:
  chat.postMessage has message_truncated, conversations.open has no_op and
  already_open.
  (https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/web-api/src/WebClient.ts)

- **Rate limit tier definitions**  
  Tier 1: 1+/min. Tier 2: 20+/min. Tier 3: 50+/min, 'typically attached to
  methods with paginating collections of conversations or users. Sporadic bursts
  are welcome'. Tier 4: 100+/min. Special: per-method. Limits apply per app, per
  workspace, per method, and calls to other methods are not restricted. Slack
  says tier limits are subject to change. The java-slack-sdk
  MethodsRateLimitTier enum mirrors this.  
  _Source (official-doc, high):_ https://docs.slack.dev/apis/web-api/rate-limits
  _Verifier:_ CONFIRMED. java-slack-sdk MethodsRateLimitTier.java (links to
  docs.slack.dev/apis/web-api/rate-limits) gives Tier1 '1+ per minute', Tier2
  '20+', Tier3 '50+ ... typically attached to methods with paginating
  collections of conversations or users. Sporadic bursts are welcome.', Tier4
  '100+'. A search excerpt of the official page confirms the per-method,
  per-app, per-workspace evaluation and that 'tiers ... are subject to change'.
  The 2018 changelog adds that all tokens of one app in a workspace share one
  pool.
  (https://raw.githubusercontent.com/slackapi/java-slack-sdk/main/slack-api-client/src/main/java/com/slack/api/methods/MethodsRateLimitTier.java)

- **Rate tier for chat.postMessage**  
  Special. Generally 1 message per second per channel (each DM is its own
  channel), plus a workspace-wide limit of 'several hundred messages per
  minute'. Generous bursts are allowed, but with bursts 'there is no guarantee
  that messages will be stored or displayed to users'. java-slack-sdk maps
  CHAT_POST_MESSAGE to SpecialTier_chat_postMessage with 60/min per channel.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/chat.postMessage _Verifier:_
  CONFIRMED. The official JSON has rate_limits t5 (Special). The java-slack-sdk
  javadoc for SpecialTier_chat_postMessage quotes the docs: 'generally allow an
  app to post 1 message per second to a specific channel ... limiting posting to
  several hundred messages per minute. Generous burst behavior is also granted.'
  The SDK sets 60/min per channel and keys its limiter on CHAT_POST_MESSAGE +
  '_' + channel. Separately from rate limits, chat.postMessage also documents
  message_limit_exceeded: 'Members on this team are sending too many messages',
  a free-workspace usage limit.
  (https://raw.githubusercontent.com/slackapi/java-slack-sdk/main/slack-api-client/src/main/java/com/slack/api/methods/MethodsRateLimitTier.java)

- **Rate tier for conversations.open and users.lookupByEmail**  
  Both are Tier 3 (50+/min). Slack's java-slack-sdk MethodsRateLimits.java has
  setRateLimitTier(CONVERSATIONS_OPEN, Tier3) and
  setRateLimitTier(USERS_LOOKUP_BY_EMAIL, Tier3). The users.lookupByEmail method
  page shows Tier 3 per search excerpt. The conversations.open page's tier could
  not be read directly and rests on the SDK table.  
  _Source (source-code, high):_
  https://raw.githubusercontent.com/slackapi/java-slack-sdk/main/slack-api-client/src/main/java/com/slack/api/methods/MethodsRateLimits.java
  _Verifier:_ CONFIRMED (upgraded to official). Slack's own reference JSON has
  rate_limits 't3' for both conversations.open and users.lookupByEmail.
  java-slack-sdk MethodsRateLimits.java agrees:
  setRateLimitTier(CONVERSATIONS_OPEN, Tier3) at line 338 and
  setRateLimitTier(USERS_LOOKUP_BY_EMAIL, Tier3) at line 488. This closes the
  researcher's open question about the conversations.open tier.
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/conversations.open.json)

- **Behavior when rate limited (429 and Retry-After)**  
  Over a limit, Slack returns HTTP 429 Too Many Requests with a Retry-After
  header giving the whole number of seconds to wait. The body error is
  'ratelimited' ('The request has been ratelimited. Refer to the Retry-After
  header for when to retry the request.'). chat.postMessage also documents
  'rate_limited' ('Application has posted too many messages'), so handle both
  strings. node-slack-sdk parses Retry-After with parseInt, pauses its queue for
  that many seconds, then retries; the default retry policy is
  tenRetriesInAboutThirtyMinutes, and rejectRateLimitedCalls=true makes it throw
  instead.  
  _Source (official-doc, high):_ https://docs.slack.dev/apis/web-api/rate-limits
  _Verifier:_ CONFIRMED. A search excerpt of the official rate-limits page
  confirms HTTP 429 with a Retry-After header in seconds, and that calls to
  other methods are not restricted. The official JSON errors have ratelimited
  ('...Refer to the Retry-After header...') and chat.postMessage's rate_limited
  ('Application has posted too many messages'). In node SDK source,
  parseRetryHeaders uses Number.parseInt(retry-after,10). On a 429 it pauses
  requestQueue, waits retrySec*1000 ms, resumes and throws to trigger a retry;
  rejectRateLimitedCalls=true throws an AbortError(WebAPIRateLimitedError)
  instead. The default retryConfig is tenRetriesInAboutThirtyMinutes
  {retries:10, factor:1.96821, randomize:true}. A 429 …
  (https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/web-api/src/WebClient.ts)

- **Block Kit limits relevant to a digest**  
  Up to 50 blocks per message (100 in modals and Home tabs). section.text is a
  mrkdwn or plain_text object of 1-3000 characters. section.fields allows at
  most 10 items of 2000 characters each. header.text must be plain_text, max 150
  characters. block_id max 255 characters and should be unique. context block
  elements max 10. actions block max 25 elements. markdown block text max 12,000
  characters. The 3000/150/10/255 limits come from @slack/types JSDoc and
  python-slack-sdk validators (SectionBlock text_max_length=3000, HeaderBlock
  text_max_length=150). The 50/100 block limit comes from the docs.slack.dev
  Block Kit overview and blocks reference (search excerpt). Validate before
  sending: oversized payloads fail with invalid_blocks or msg_blocks_too_long.  
  _Source (source-code, high):_
  https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/types/src/block-kit/blocks.ts
  _Verifier:_ CONFIRMED. @slack/types blocks.ts (main) has: block_id max 255 and
  should be unique; actions block max 25 elements; context elements max 10;
  header text plain_text max 150; section text 1-3000; section fields max 10
  items of 2000 characters each; markdown block 12,000. A search excerpt of the
  official Block Kit page confirms 'up to 50 blocks in each message, and 100
  blocks in modals or Home tabs'. Also present: the table block allows max 100
  rows and 20 cells per row. invalid_blocks, invalid_blocks_format and
  msg_blocks_too_long are in the official chat.postMessage error JSON.
  (https://raw.githubusercontent.com/slackapi/node-slack-sdk/main/packages/types/src/block-kit/blocks.ts)

- **Link syntax and escaping in mrkdwn**  
  A labeled link is <https://example.com|label text>. Bare URLs auto-link.
  Mention a user with <@U123>. Escape only the three control characters &, <
  and > as &amp;, &lt;, &gt; in literal text such as issue titles; do not
  HTML-encode anything else. A '|' or '>' inside label text should be escaped or
  stripped, which is inferred from the delimiter syntax.  
  _Source (official-doc, high):_
  https://docs.slack.dev/messaging/formatting-message-text _Verifier:_ CONFIRMED
  (excerpt only). A search excerpt of the official formatting page says &, <
  and > are control characters and must be converted to &amp;, &lt;, &gt;, and
  that 'you shouldn't HTML entity-encode the entire text, as only the specific
  characters shown above will be decoded'. Escaping '|' inside label text is
  still inferred. (https://docs.slack.dev/messaging/formatting-message-text)

- **Top-level 'text' fallback requirement**  
  text is not enforced when blocks are present, but Slack strongly recommends it
  as the fallback for notifications. Without blocks, text is the message body.
  node-slack-sdk logs a warning when chat.postMessage has no text ('used in
  places where the content cannot be rendered such as: system push
  notifications, assistive technology such as screen readers'). Keep text at or
  under 4,000 characters for best results; Slack truncates messages over 40,000
  characters. markdown_text (max 12,000) cannot be combined with text or blocks,
  which gives the error markdown_text_conflict.  
  _Source (official-doc, high):_
  https://docs.slack.dev/reference/methods/chat.postMessage _Verifier:_
  CONFIRMED. A search excerpt of the official page says 'For best results, limit
  the number of characters in the text field to 4,000 characters. Slack will
  truncate messages containing more than 40,000 characters.' The official JSON
  warning message_truncated says 'The text field of a message should have no
  more than 40,000 characters.' markdown_text is 'Limit this field to 12,000
  characters' and 'should not be used in conjunction with blocks or text', and
  the markdown_text_conflict error exists. The node SDK warnIfFallbackIsMissing
  text is quoted correctly; it applies to chat.postMessage, chat.postEphemeral
  and chat.scheduleMessage and is suppressed when markdown_text is set.
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/chat.postMessage.json)

- **Error codes to handle**  
  users.lookupByEmail: users_not_found (no such email, and also returned for
  deactivated users per the docs). conversations.open: user_not_found,
  user_disabled, user_not_visible, channel_not_found, missing_scope.
  chat.postMessage: channel_not_found ('Value passed for channel was invalid'),
  not_in_channel ('Cannot post user messages to a channel they are not in'; not
  expected when posting to a user ID or DM), is_archived, messages_tab_disabled,
  invalid_blocks, invalid_blocks_format, msg_blocks_too_long, no_text,
  restricted_action, ekm_access_denied, rate_limited. All three methods:
  invalid_auth, not_authed, account_inactive ('Authentication token is for a
  deleted user or workspace when using a bot token'), token_revoked,
  token_expired, missing_scope, ratelimited, service_unavailable, fatal_error,
  request_timeout, invalid_charset, invalid_post_type, team_added_to_org.
  Suggested handling: re…  
  _Source (community, high):_
  https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/methods/chat/chat.postMessage.json
  _Verifier:_ CONFIRMED, with one addition and one clarification.
  Method-specific codes in Slack's official JSON: users.lookupByEmail has only
  enterprise_is_restricted and users_not_found. A search excerpt of the official
  page says deactivated users also return users_not_found and suggests
  users.list filtering as the workaround. conversations.open has
  app_cannot_join_channel, channel_not_found, invalid_user_combination,
  method_not_supported_for_channel_type, missing_scope, not_enough_users,
  restricted_action, too_many_users, user_disabled, user_not_found,
  user_not_visible and users_list_not_supplied. chat.postMessage includes all
  the codes the researcher listed, and also message_limit_exceeded (free-work…
  (https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/chat.postMessage.json)

- **2025-2026 rate-limit changes for non-Marketplace apps and whether they
  affect chat.postMessage**  
  The 2025-05-29 changelog 'Rate limit changes for non-Marketplace apps' covers
  only conversations.history and conversations.replies. For commercially
  distributed apps not approved for the Marketplace, both move from Tier 3 to
  Tier 1 (1 request/min) and the limit parameter's max and default drop to 15.
  Marketplace apps and internal customer-built apps are not affected. The
  changes applied to new apps and installs from 2025-05-29. Slack's pages
  disagree on existing installs: the terms FAQ says 2026-03-03 (replacing an
  earlier 2025-09-02 date), while the conversations.history page says existing
  installs are not subject. No source names chat.postMessage, conversations.open
  or users.lookupByEmail, so they keep their tiers (Special, Tier 3, Tier 3).
  That they are unaffected is inferred from them not being listed and from
  java-slack-sdk still mapping them unchanged. An internal single-workspace…  
  _Source (changelog, high):_
  https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
  _Verifier:_ CONFIRMED that only conversations.history and
  conversations.replies are affected: they go to Tier 1, at most 15 objects.
  CORRECTED on the exemption wording. The 2025-06-03 'rate limits clarity'
  changelog only explicitly exempts 'internal customer-built apps created before
  May 29th, 2025'. A terms FAQ excerpt suggests newly created non-Marketplace
  apps are subject immediately. The rate-limits page says internal
  customer-built apps should not see changes. So whether a brand-new internal
  app created in 2026 is exempt is ambiguous, but it does not matter:
  chat.postMessage (t5/Special), conversations.open (t3) and users.lookupByEmail
  (t3) keep their tiers in Slack's current reference JSON (refre…
  (https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity)

- **Other recent changes or SDK versions**  
  chat.postMessage now also accepts markdown_text (12,000 characters, mutually
  exclusive with text/blocks), unfurl_app_links and metadata.entities (Work
  Objects), and there are chat.startStream, appendStream and stopStream
  streaming methods. None of these change DM posting. The npm @slack/web-api
  latest is 8.2.0 (published 2026-09-30); 8.0.0 was published 2026-07-14. A
  WebSearch summary mentions a third-party blog claiming an October 2026 test
  accepted a 40,001-character message without warning; this is unverified, so
  keep text at or under 4,000 characters anyway.  
  _Source (source-code, medium):_ https://registry.npmjs.org/@slack/web-api
  _Verifier:_ CONFIRMED: the npm registry has @slack/web-api dist-tags
  latest=8.2.0 (2026-09-30T22:11:19Z) and 8.0.0 (2026-07-14T17:55:24Z); 8.1.0
  and 8.1.1 are both from 2026-08-27. 8.2.0 requires node '>= 20' and depends on
  @slack/types ^3.2.0, p-queue and p-retry. Slack's official methods list
  contains chat.startStream, chat.appendStream and chat.stopStream.
  unfurl_app_links and Work Object metadata are in the official chat.postMessage
  args. UNVERIFIABLE: the third-party claim that a 40,001-character message was
  accepted without warning. The official JSON still documents the
  message_truncated warning at 40,000.
  (https://registry.npmjs.org/@slack/web-api)

### Added by the verifier

- **MISSED: Is there an official machine-readable Slack method reference to code
  against?**  
  Yes. https://docs.slack.dev/reference/methods.json lists all 340 methods, and
  https://docs.slack.dev/reference/methods/{method}.json has per-method fields:
  scope.bot, scope.user, rate_limits (t1-t4, t5=Special), http_method,
  json_input_supported, args JSON-schema, errors, warnings and examples. A
  search result also shows .md versions of pages, e.g.
  docs.slack.dev/reference/methods/chat.postmessage.md. slack-ruby/slack-api-ref
  keeps a verbatim, regularly refreshed mirror under docs.slack.dev/, which can
  be reached when Slack's domains are blocked.  
  _Source (official-doc, high):_
  https://raw.githubusercontent.com/slack-ruby/slack-api-ref/master/docs.slack.dev/methods/methods.json

- **MISSED: What does chat.postMessage return when the bot cannot DM the target
  user?**  
  channel_not_found. Per a search excerpt of the official chat.postMessage page:
  'You will receive a channel_not_found error if your app doesn't have
  permission to enter into a DM with the intended user.' The same page says bot
  users cannot post into a DM between two other users. Treat channel_not_found
  on a user-ID post as a per-recipient failure, not only as a stale cached D-ID.
  The exact codes for deactivated, guest or Slack Connect recipients are still
  unconfirmed.  
  _Source (official-doc, medium):_
  https://docs.slack.dev/reference/methods/chat.postMessage

### Open questions

- The docs.slack.dev pages could not be fetched directly; the method-page
  wording was seen only through WebSearch excerpts. Re-check the
  users.lookupByEmail and conversations.open 'Facts' boxes for scope and tier
  once a docs fetch is possible.
- Whether messages_tab_disabled is still raised today when Messages Tab is off.
  It is in the scraped error list but was not confirmed on the live page; enable
  messages_tab_enabled in the manifest regardless.
- Exact chat.postMessage behavior when the target user ID is deactivated, a
  guest, or an external Slack Connect user: likely channel_not_found or
  user_disabled, but this is unconfirmed and needs a live test.
- Whether users.lookupByEmail returns users_not_found for valid emails when
  users:read.email is missing (community claim) rather than missing_scope.
  Unverified.
- Slack's two pages conflict on whether the conversations.history/replies Tier 1
  limit applies to existing non-Marketplace installs from 2026-03-03. This does
  not matter for this app unless history reads are added.
- Polarity of features.app_home.messages_tab_read_only_enabled: the official
  description ('Whether or not the users can send messages to your app') is
  ambiguous. Confirm in the App Home dashboard that true means users cannot
  reply.
- Whether a brand-new internal (non-distributed) app created after 2025-05-29
  counts as exempt from the non-Marketplace conversations.history/replies
  limits. Slack's pages disagree. It only matters if history reads are added.
- The chat.postMessage response 'channel' field holding the D... IM ID when
  posting to a U... ID is still inferred and needs a live call.
- Exact error codes for posting to a deactivated user, a guest, or an external
  Slack Connect user (likely channel_not_found) are unconfirmed without a live
  test.
- Whether users.lookupByEmail returns users_not_found or missing_scope when
  users:read.email is missing remains unverified.

## Railway deployment

- **CRITICAL: Is Config as Code (railway.json / railway.toml) still usable for a
  newly created service?**  
  No. The official docs mark Config as Code as DEPRECATED (added in docs PR
  #1304 on 2026-08-21). Quote: 'Existing railway.json / railway.toml files
  continue to work for services that already use them until 2026-12-01 (hard
  cutoff). New services cannot opt into Config as Code.' The replacement is
  Infrastructure as Code (IaC): one file, .railway/railway.ts (TypeScript is GA;
  .railway/railway.py and .railway/railway.go are beta), evaluated and applied
  by the Railway CLI (`railway config init|pull|plan|apply|migrate`). A service
  cannot be managed by both systems at once. Railway staff and bot replies on
  Station confirm this, and a Station thread titled 'railway.toml has no effect'
  shows the practical effect. For this greenfield app, a railway.json committed
  to the repo would be IGNORED by the new services.  
  _Source (official-doc, high):_ https://docs.railway.com/config-as-code
  (source:
  https://github.com/railwayapp/docs/blob/main/content/docs/config-as-code.md);
  https://docs.railway.com/infrastructure-as-code _Verifier:_ CONFIRMED. The
  docs source has the banner: 'Config as Code is deprecated... Existing
  railway.json / railway.toml files continue to work for services that already
  use them until 2026-12-01 (hard cutoff). New services cannot opt into Config
  as Code.' It was added in commit 5dc40e7, 'deprecate Config as Code docs (CaC
  -> IaC PR1) (#1304)', on 2026-08-21. infrastructure-as-code.md adds: 'Existing
  Config as Code files stop being read on 2026-12-01', and 'A service cannot be
  managed by both systems at the same time.' It also says `railway config plan`
  refuses to manage a service while that service is still managed by CaC. A
  Station thread titled 'railway.toml has no effect — what replaces it befo…
  (https://github.com/railwayapp/docs/blob/main/content/docs/config-as-code.md ;
  https://github.com/railwayapp/docs/blob/main/content/docs/infrastructure-as-code.md
  ; https://github.com/railwayapp/docs/commit/5dc40e7 ;
  https://station.railway.com/questions/railway-toml-has-no-effect-what-replac-b623aa81)

- **Config as Code: file names, schema URL, custom config path, and precedence
  (legacy, for reference)**  
  By default Railway looks for `railway.toml` or `railway.json`. The schema is
  `"$schema": "https://railway.com/railway.schema.json"`; SchemaStore maps both
  railway.toml and railway.json to that URL. I could not download the schema
  itself because railway.com is unreachable from this sandbox. Custom path: set
  it on the service settings page as an ABSOLUTE repo path, e.g.
  `/backend/railway.toml`. 'The Railway Config File does not follow the Root
  Directory path.' Config in code overrides dashboard values, but only for that
  deployment; the dashboard is not updated. Environment overrides go under
  `environments.<name>`; the special `pr` key applies to PR environments.
  Resolution order is env-specific code config, then base code config, then
  service settings.  
  _Source (official-doc, high):_ https://docs.railway.com/config-as-code ;
  https://docs.railway.com/builds/build-configuration ;
  https://raw.githubusercontent.com/SchemaStore/schemastore/master/src/api/json/catalog.json
  _Verifier:_ CONFIRMED. The CaC reference says: 'By default, we will look for a
  railway.toml or railway.json file.' The schema URL is
  https://railway.com/railway.schema.json, and SchemaStore's catalog maps
  fileMatch [railway.toml, railway.json] to that URL (checked). For a custom
  path, provide 'the absolute path to the file in your repository, for example:
  /backend/railway.toml'. build-configuration.md and monorepo.md both say 'The
  Railway Config File does not follow the Root Directory path.' The resulting
  config is used 'only for the current deployment' and the dashboard is not
  updated. Environment priority is env-specific config in code, then base config
  in code, then service settings. PR priority is …
  (https://github.com/railwayapp/docs/blob/main/content/docs/config-as-code/reference.md
  ;
  https://raw.githubusercontent.com/SchemaStore/schemastore/master/src/api/json/catalog.json)

- **Config as Code: exact build/deploy keys (legacy)**  
  build: `builder` (documented values `RAILPACK` (default) | `DOCKERFILE`;
  'Railway will always build with a Dockerfile if it finds one'),
  `watchPatterns` (string[]), `buildCommand` (string|null), `dockerfilePath`
  (string|null), `railpackVersion` (string|null). deploy: `startCommand`,
  `preDeployCommand` (an ARRAY, e.g. ["npm run db:migrate"]), `healthcheckPath`,
  `healthcheckTimeout` (seconds), `restartPolicyType`
  (`ON_FAILURE`|`ALWAYS`|`NEVER`), `restartPolicyMaxRetries`, `cronSchedule`
  (e.g. "*/15 * * * *"), `multiRegionConfig` ({region: {numReplicas}}),
  `overlapSeconds`, `drainingSeconds`. The full backend shape in the CLI and SDK
  also has `numReplicas`, `preDeployTimeoutSeconds`, `sleepApplication`,
  `region`, `limitOverride`, `ipv6EgressEnabled`, `registryCredentials`, and
  `requiredMountPath`. The SDK/CLI builder enum still lists NIXPACKS, HEROKU and
  PAKETO as legacy values, but the do…  
  _Source (official-doc, high):_
  https://docs.railway.com/config-as-code/reference ;
  https://github.com/railwayapp/cli/blob/main/src/controllers/config/environment.rs
  _Verifier:_ CONFIRMED, with two small corrections. The docs list builder
  values RAILPACK (default) and DOCKERFILE, and say 'Railway will always build
  with a Dockerfile if it finds one.' The documented keys are watchPatterns,
  buildCommand, dockerfilePath, railpackVersion, startCommand, preDeployCommand
  (array), multiRegionConfig, healthcheckPath, healthcheckTimeout,
  restartPolicyType, restartPolicyMaxRetries, cronSchedule, overlapSeconds and
  drainingSeconds; all are present. Correction 1: the CLI's DeployConfig struct
  (src/controllers/config/environment.rs) has NO `region` field. `region` exists
  only in the SDK's DeployConfig type. Correction 2: HEROKU and PAKETO appear
  only in the SDK builder union. Th…
  (https://github.com/railwayapp/docs/blob/main/content/docs/config-as-code/reference.md
  ;
  https://github.com/railwayapp/cli/blob/main/src/controllers/config/environment.rs
  ; https://registry.npmjs.org/railway/-/railway-3.16.0.tgz
  (dist/index-CweUhAOc.d.ts))

- **IaC (.railway/railway.ts): how do I express the same build/deploy
  settings?**  
  `import { defineRailway, project, service, postgres, github, preserve } from "railway/iac"` (npm
  package `railway`, latest 3.16.0, published 2026-10-14 by Railway
  maintainers). Shorthands: `build: "cmd"` (becomes buildCommand), `start`,
  `preDeploy` (string or string[], becomes preDeployCommand[]), `healthcheck`
  (healthcheckPath), `healthcheckTimeout`, `replicas` (a number gives
  numReplicas; a {region: n} map gives multiRegionConfig),
  `domains: ["app.example.com" | {domain, port}]`, `env: {...}`, `rootDirectory`
  (or `root`), and `source: github("owner/repo", { branch, rootDirectory })`.
  For anything else, pass the raw objects:
  `build: { builder: "DOCKERFILE", dockerfilePath: "apps/web/Dockerfile", watchPatterns: ["/apps/web/**", "/packages/**"] }`
  and
  `deploy: { cronSchedule: "*/15 * * * *", restartPolicyType: "NEVER", restartPolicyMaxRetries: 0, preDeployTimeoutSeconds: 600 }`.
  The SDK …  
  _Source (source-code, medium):_
  https://docs.railway.com/infrastructure-as-code/reference ;
  https://docs.railway.com/functions ;
  https://registry.npmjs.org/railway/-/railway-3.16.0.tgz (dist/index.js
  normalizeBuild/normalizeDeploy, dist/index-CweUhAOc.d.ts) ;
  https://github.com/railwayapp/cli/blob/main/src/iac/eval.rs _Verifier:_
  CONFIRMED from SDK source (railway@3.16.0, latest, published 2026-10-14T09:57Z
  via GitHub Actions OIDC from railwayapp/railway-ts-sdk; engines node >=22).
  normalizeBuild: when `build` is a string it becomes only {buildCommand};
  otherwise the object is spread as-is. To set builder, dockerfilePath or
  watchPatterns TOGETHER with a build command, use the object form
  `build: { builder, buildCommand, dockerfilePath, watchPatterns }`.
  normalizeDeploy spreads `config.deploy`, then overlays start/startCommand,
  preDeploy/preDeployCommand (wrapped into an array),
  healthcheck/healthcheckPath, healthcheckTimeout and replicas. A number maps to
  numReplicas; a map maps to multiRegionConfig. Service-level `…
  (https://registry.npmjs.org/railway/-/railway-3.16.0.tgz (dist/iac/index.js
  normalizeBuild/normalizeDeploy/github) ;
  https://github.com/railwayapp/cli/blob/main/src/iac/eval.rs ;
  https://github.com/railwayapp/docs/blob/main/content/docs/infrastructure-as-code/reference.md
  ; https://github.com/railwayapp/docs/blob/main/content/docs/functions.md)

- **IaC caveats relevant to this app**  
  (1) If you set `domains` without a port, the SDK defaults the custom-domain
  target port to 8080 (`normalizeNetworking`). Always pass `{domain, port}`
  explicitly. (2) Generated *.up.railway.app domains are not managed in
  railway.ts. (3) In a one-file setup, deleting a resource from the file deletes
  it on the next apply. Non-interactive destructive applies need
  `--confirm-destructive`. (4) `railway config migrate` (CaC to IaC) does not
  carry `cronSchedule` over as a setting: it only emits a comment ('cronSchedule
  from CaC: ...'). Its CaC parser has no restartPolicy fields, so those are
  dropped too (from CLI source). (5) A Station thread ('Infrastructure as Code:
  watchPatterns & dockerfilePath') reported gaps for these fields. The current
  SDK types and CLI structs do include them, so verify with
  `railway config plan --show-values` before relying on them. (6) Another
  Station thread ('IaC do…  
  _Source (source-code, medium):_
  https://registry.npmjs.org/railway/-/railway-3.16.0.tgz ;
  https://github.com/railwayapp/cli/blob/main/src/commands/config/migrate.rs ;
  https://station.railway.com/community/infrastructure-as-code-watchpatterns-f162fbad
  ;
  https://station.railway.com/feedback/iac-does-not-feel-production-ready-for-r-da53d29a
  _Verifier:_ (1) CONFIRMED. normalizeNetworking maps a string domain, or
  {domain} without a port, to {port: 8080}. (2) CONFIRMED. The docs say
  'Generated Railway service domains are not included in .railway/railway.ts'.
  (3) CONFIRMED. The docs say 'omitting a resource means deleting it', and
  non-interactive destructive applies need `--confirm-destructive`. NEW: the
  railwayapp/config GitHub Action input `confirm-destructive` DEFAULTS TO "true"
  ('merging is the approval'), so merging a PR that drops a resource deletes it.
  (4) CONFIRMED and extended. In migrate.rs, the CacDeploy struct holds only
  startCommand, preDeployCommand, preDeployTimeoutSeconds, healthcheckPath,
  healthcheckTimeout, numReplicas, regi…
  (https://registry.npmjs.org/railway/-/railway-3.16.0.tgz ;
  https://github.com/railwayapp/cli/blob/main/src/commands/config/migrate.rs ;
  https://raw.githubusercontent.com/railwayapp/config/main/action.yml ;
  https://station.railway.com/community/infrastructure-as-code-watchpatterns-f162fbad
  ;
  https://station.railway.com/feedback/iac-does-not-feel-production-ready-for-r-da53d29a)

- **Root directory vs shared (pnpm workspace) monorepos**  
  Railway distinguishes two cases. An isolated monorepo sets a Root Directory
  per service: 'Railway will only pull down files from that directory'. A shared
  monorepo (pnpm/yarn/npm workspaces) keeps the root at `/` and gives each
  service its own build/start commands, e.g. `pnpm --filter web build` /
  `pnpm --filter web start` (CLI:
  `railway environment edit --service-config <svc> build.buildCommand "..."`).
  Watch paths are gitignore-style patterns. They always match from `/`, even
  when a root directory is set (for root `/app`, use `/app/**.js`). A deploy is
  skipped when no changed file matches. Importing a JS monorepo from
  railway.com/new auto-stages one service per deployable package, with
  `pnpm --filter <pkg> build/start` and watch paths like `/packages/backend/**`.
  Inconsistency: the IaC reference's 'Larger example' sets
  `rootDirectory: "apps/api"` together with
  `pnpm --filter api build…   _Source (official-doc, high):_ https://docs.railway.com/deployments/monorepo ; https://docs.railway.com/builds/build-configuration ; https://docs.railway.com/infrastructure-as-code/reference _Verifier:_ CONFIRMED. monorepo.md says that setting the root directory 'means that Railway will only pull down files from that directory'. For a shared monorepo, keep the root and set per-service build/start commands; the doc's CLI example is `railway
  environment edit --service-config backend build.buildCommand "pnpm --filter
  backend
  build"`. build-configuration.md: 'if a Root Directory is provided, patterns still operate from /. For a root directory of /app, /app/**.js'. The JS auto-import sets `pnpm
  --filter [package] build/start`and watch paths like`/packages/backend/**`, and
  still says 'railway.json / railway.toml are detected at the root of the
  package directory' (a stale line). The IaC referen…
  (https://github.com/railwayapp/docs/blob/main/content/docs/deployments/monorepo.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/builds/build-configuration.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/infrastructure-as-code/reference.md)

- **Cron: how cronSchedule works, timezone, minimum interval, exit requirement,
  overlap behavior**  
  Cron schedules are standard 5-field crontab expressions set in Service
  Settings > Cron Schedule, in `deploy.cronSchedule` (CaC), or in IaC
  `deploy: { cronSchedule }`. On each tick Railway runs the service's START
  COMMAND. Times are in UTC. Runs must be at least 5 minutes apart, and every
  consecutive pair counts, including across the hour: `*/5` is valid, `*/7` is
  INVALID because 10:56 to 11:00 is only 4 minutes. Execution time is not
  guaranteed to the minute and can drift by a few minutes. The process MUST exit
  when done and close DB connections. 'Railway does not automatically terminate
  deployments. As a result, if a previous execution is still running when the
  next scheduled execution is due, Railway will skip the new cron job.' Skipped
  runs show status SKIPPED in `railway cron list`; other statuses are EXITED,
  CRASHED and RUNNING. `railway cron run` triggers an off-schedule run. Docs…  
  _Source (official-doc, high):_ https://docs.railway.com/cron-jobs ;
  https://docs.railway.com/cli/cron ;
  https://docs.railway.com/guides/cron-workers-queues _Verifier:_ CONFIRMED.
  Railway executes the service's start command on the schedule. Schedules are in
  UTC. 'Scheduled runs must be at least 5 minutes apart in UTC. This applies to
  every pair of runs, including when the hour changes', with */5 valid and */7
  invalid. The docs say 'Railway does not guarantee execution times to the
  minute as they can vary by a few minutes' and 'Railway does not automatically
  terminate deployments... Railway will skip the new cron job.' cli/cron.md
  lists run statuses EXITED, CRASHED, RUNNING and SKIPPED, plus
  CREATED/INITIALIZING/RESTARTING ('starting up') and STOPPED/REMOVED/REMOVING.
  `railway cron run` (alias trigger) needs `--yes` when not on a TTY. The
  cron-workers-queu…
  (https://github.com/railwayapp/docs/blob/main/content/docs/cron-jobs.md ;
  https://github.com/railwayapp/docs/blob/main/content/docs/cli/cron.md ;
  https://github.com/railwayapp/docs/blob/main/content/guides/cron-workers-queues.md)

- **Can a cron service share the Dockerfile/image definition with the web
  service?**  
  Yes, but this is inferred: no doc page states it directly. Each Railway
  service has its own source, build and deploy settings, so two services can
  point at the same repo and Dockerfile and differ only in start command and
  cron schedule. Each service builds its own image. For Dockerfile/image
  services, the custom start command REPLACES the image ENTRYPOINT in exec form,
  so env-var expansion needs `/bin/sh -c "exec node dist/cron.js"`. Without an
  override, the Dockerfile's ENTRYPOINT/CMD is used. For Railpack services, the
  start command runs in a shell. Separate Dockerfiles per service: set
  `RAILWAY_DOCKERFILE_PATH` (service variable, e.g. `/apps/worker/Dockerfile`)
  or `dockerfilePath`. Pitfall from Station threads: a root `Dockerfile` (or a
  root railway.toml) can be picked up instead of the intended path, because
  Railway always uses a detected Dockerfile.  
  _Source (inferred, medium):_
  https://docs.railway.com/deployments/start-command ;
  https://docs.railway.com/builds/dockerfiles ;
  https://station.railway.com/questions/custom-dockerfile-path-is-ignored-railw-8477b5bc
  _Verifier:_ CONFIRMED for the documented parts; the overall pattern remains
  inferred. start-command.md: 'Dockerfile / Image: the start command overrides
  the image's ENTRYPOINT in exec form... wrap your command in a shell - /bin/sh
  -c "exec python main.py --port $PORT"'. 'Railpack: the start command is ran in
  a shell process.' Without an override, 'the start command defaults to the
  ENTRYPOINT and / or CMD'. The RAILWAY_DOCKERFILE_PATH service variable is
  documented (e.g. /build/Dockerfile), as is CaC/IaC dockerfilePath. 'Railway
  will always build with a Dockerfile if it finds one' is in the CaC reference.
  No doc says outright that two services can share one repo and Dockerfile with
  different start comma…
  (https://github.com/railwayapp/docs/blob/main/content/docs/deployments/start-command.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/builds/dockerfiles.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/config-as-code/reference.md)

- **Restart policy defaults (relevant to the cron worker)**  
  The default is `ON_FAILURE` with a maximum of 10 restarts. The values are
  ALWAYS, ON_FAILURE and NEVER. Free/trial plans cannot use ALWAYS and are
  capped at 10 retries. With replicas, only the crashed replica restarts. The
  docs do not say how a restart policy interacts with cron runs. Setting
  `restartPolicyType: NEVER` on the cron service avoids re-running a failed
  batch, but this is inferred, not documented.  
  _Source (official-doc, medium):_
  https://docs.railway.com/deployments/restart-policy _Verifier:_ CONFIRMED.
  'The default is On Failure with a maximum of 10 restarts.' The policies are
  Always, On Failure and Never. Free/trial plans cannot use Always, and On
  Failure is capped at 10 there. With replicas, only the crashed replica
  restarts. The docs say nothing about restart policy and cron runs (I grepped
  the whole docs repo). The only hint is that cron run statuses include
  RESTARTING, which suggests restarts can apply to cron runs. Using NEVER for
  the cron service stays an inference.
  (https://github.com/railwayapp/docs/blob/main/content/docs/deployments/restart-policy.md
  ; https://github.com/railwayapp/docs/blob/main/content/docs/cli/cron.md)

- **Postgres: variables exposed by the Railway Postgres service**  
  Documented: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE and DATABASE_URL.
  DATABASE_PUBLIC_URL is populated once you add Public Access (a TCP proxy,
  which is billed for egress). The SDK's typed PostgresVariable list adds
  PGDATA, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER and SSL_CERT_DAYS, plus
  the Railway-provided RAILWAY_PRIVATE_DOMAIN, RAILWAY_TCP_PROXY_DOMAIN and
  RAILWAY_TCP_PROXY_PORT. Databases are private by default. The default image is
  ghcr.io/railwayapp-templates/postgres-ssl:18 (IaC `postgres()` helper); output
  variable DATABASE_URL, data at /var/lib/postgresql/data. The private-network
  URL looks like
  `postgresql://postgres:<pw>@postgres.railway.internal:5432/railway`.  
  _Source (official-doc, high):_ https://docs.railway.com/databases/postgresql ;
  https://docs.railway.com/databases/build-a-database-service ;
  https://registry.npmjs.org/railway/-/railway-3.16.0.tgz _Verifier:_ CONFIRMED.
  The docs list PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE and DATABASE_URL.
  Databases are 'deployed private by default'. Adding Public Access creates a
  TCP Proxy and populates DATABASE_PUBLIC_URL, billed as Network Egress. The SDK
  PostgresVariable type adds DATABASE_PUBLIC_URL, PGDATA, POSTGRES_DB,
  POSTGRES_PASSWORD, POSTGRES_USER and SSL_CERT_DAYS, plus Railway-provided
  variables. The SDK's postgres() uses image
  ghcr.io/railwayapp-templates/postgres-ssl:18, output DATABASE_URL and
  defaultMountPath /var/lib/postgresql/data. The example
  `postgresql://postgres:password@postgres.railway.internal:5432/railway`
  appears in build-a-database-service.md.
  (https://github.com/railwayapp/docs/blob/main/content/docs/databases/postgresql.md
  ; https://registry.npmjs.org/railway/-/railway-3.16.0.tgz)

- **Variable reference syntax**  
  `${{NAMESPACE.VAR}}`, where NAMESPACE is the referenced service's name exactly
  as shown in Railway (e.g. `${{Postgres.DATABASE_URL}}`), or `shared` for
  shared variables (`${{shared.API_KEY}}`). Use `${{VAR}}` for the same service.
  Spaces inside the braces are allowed (`${{ Postgres.DATABASE_URL }}`), and
  references can be composed:
  `BACKEND_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`. In IaC,
  `db.env.DATABASE_URL` compiles to a reference and `ctx.shared.NAME` compiles
  to `${{shared.NAME}}`. `preserve()` keeps the existing value in Railway, which
  suits secrets you don't want in source. Sealed variables are never shown in
  the UI or API and are not copied to PR environments.  
  _Source (official-doc, high):_ https://docs.railway.com/variables ;
  https://docs.railway.com/variables/reference ;
  https://docs.railway.com/infrastructure-as-code/reference _Verifier:_
  CONFIRMED. variables/reference.md defines `${{NAMESPACE.VAR}}`, where
  NAMESPACE is 'shared' or the service name (e.g. 'Postgres'). Spaced forms like
  `${{ shared.VARIABLE_KEY }}` appear in variables.md. The composed
  `BACKEND_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` is in
  working-with-domains.md. In IaC, `ctx.shared.NAME` 'compiles to
  ${{shared.NAME}}', and preserve() 'keep[s] the value that is already set in Railway'. Sealed variables are 'never visible in the UI nor can it be retrieved via the API' and 'are not copied over when creating PR environments'. Caveat (community, staff per search snippets): PORT is injected at runtime and is not a stored variable, so `${{api.PORT}…
  (https://github.com/railwayapp/docs/blob/main/content/docs/variables/reference.md
  ; https://github.com/railwayapp/docs/blob/main/content/docs/variables.md ;
  https://station.railway.com/questions/private-networking-unable-to-access-por-5e15f237)

- **Private networking hostnames and protocol**  
  Each service gets `<service-name>.railway.internal` (the
  RAILWAY_PRIVATE_DOMAIN variable). Renaming a service changes its DNS name.
  Environments created after 2025-10-16 resolve to IPv4 and IPv6; legacy
  environments are IPv6-only. Traffic runs over encrypted WireGuard tunnels. Use
  `http://`, not `https://`, internally. The network is scoped to one
  project+environment, and browsers cannot reach it. IMPORTANT: private
  networking is available ONLY AT RUNTIME, not during the build. `next build`
  therefore cannot reach the database through DATABASE_URL, while pre-deploy
  commands can.  
  _Source (official-doc, high):_
  https://docs.railway.com/networking/private-networking/how-it-works ;
  https://docs.railway.com/networking/domains/working-with-domains _Verifier:_
  CONFIRMED. The pattern is `<service-name>.railway.internal`, and renaming the
  service updates the DNS name. Environments created after October 16, 2025
  resolve to IPv4 and IPv6; legacy environments are IPv6-only. Traffic uses
  WireGuard, so use http://. Isolation is per project and environment, and
  browsers 'cannot reach the private network'. how-it-works.md, 'Build VS.
  Runtime': 'Private networking is only available at runtime, not during the
  build phase... Database migrations that require internal connectivity should
  run as part of the start command, not the build.' The pre-deploy doc
  separately says pre-deploy commands 'execute within your private network', so
  pre-deploy is fine.
  (https://github.com/railwayapp/docs/blob/main/content/docs/networking/private-networking/how-it-works.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/networking/domains/working-with-domains.md)

- **Is SSL needed for Postgres on the private network?**  
  No. The docs never require it, and the transport is already
  WireGuard-encrypted. The image source shows SSL is supported but optional:
  init-ssl.sh sets `ssl = on` with a SELF-SIGNED root CA (default 820 days,
  controlled by SSL_CERT_DAYS, auto-renewed within 30 days of expiry; the SAN
  includes localhost and RAILWAY_PRIVATE_DOMAIN). The remote-access pg_hba rule
  is `host all all all scram-sha-256`, and `host` accepts both SSL and non-SSL
  connections. On the private network, connect without SSL (or with
  `sslmode=disable`). Over the public TCP proxy (DATABASE_PUBLIC_URL), the
  certificate won't verify against public CAs. node-postgres treats
  `sslmode=require` like verify-full unless you add `uselibpqcompat=true`, so
  use `ssl: { rejectUnauthorized: false }` or `sslmode=no-verify`, or pin the
  server's root.crt.  
  _Source (source-code, medium):_
  https://github.com/railwayapp-templates/postgres-ssl/blob/main/init-ssl.sh ;
  https://github.com/railwayapp-templates/postgres-ssl/blob/main/wrapper.sh ;
  https://www.npmjs.com/package/pg-connection-string _Verifier:_ CONFIRMED from
  image source. init-ssl.sh generates a self-signed root CA (CN=root-ca) and a
  server cert (CN=localhost) with SAN DNS:localhost plus
  DNS:${RAILWAY_PRIVATE_DOMAIN} when set. Validity comes from SSL_CERT_DAYS (default 820; invalid values fall back to 820). It writes `ssl = on` and ssl_ca_file. wrapper.sh regenerates the cert when it is within 2592000 s (30 days) of expiry or lacks a SAN. The remote rule is `host all all all ${POSTGRES_HOST_AUTH_METHOD:-scram-sha-256}`, and in PostgreSQL a `host`
  rule matches both SSL and non-SSL TCP connections. The pg-connection-string
  README (latest 2.14.1): without uselibpqcompat,
  sslmode=prefer/require/verify-ca/verify-full all set ssl=true …
  (https://github.com/railwayapp-templates/postgres-ssl/blob/main/init-ssl.sh ;
  https://github.com/railwayapp-templates/postgres-ssl/blob/main/wrapper.sh ;
  https://www.npmjs.com/package/pg-connection-string)

- **Web service: PORT injection and host binding**  
  Railway injects a `PORT` env var. The app must listen on `0.0.0.0:$PORT`. The
  healthcheck also uses PORT. You may set PORT yourself as a service variable,
  and should when using target ports. For Next.js, Railway's docs use
  `next start --port ${PORT-3000}`. Their standalone Dockerfile sets
  `ENV PORT=3000` and `ENV HOSTNAME="0.0.0.0"`, then runs `node server.js` with
  `output: "standalone"`. The docs do NOT state the default injected PORT value.
  The IaC SDK's 8080 default domain port suggests it is 8080, but that is
  unconfirmed, so set PORT explicitly.  
  _Source (official-doc, high):_
  https://docs.railway.com/networking/troubleshooting/application-failed-to-respond
  ; https://docs.railway.com/deployments/healthchecks ;
  https://docs.railway.com/guides/nextjs _Verifier:_ CORRECTED (attribution) and
  EXTENDED. Confirmed: 'bind to the host 0.0.0.0 and listen on the port
  specified by the PORT environment variable, which Railway automatically
  injects'. The healthcheck uses PORT, and you can set PORT manually.
  Correction: `next start --port ${PORT-3000}` comes from the 'Application
  Failed to Respond' troubleshooting page, not the Next.js guide.
  guides/nextjs.md uses `output: "standalone"` with a start script of
  `node .next/standalone/server.js`, and its Dockerfile sets `ENV PORT=3000`,
  `ENV HOSTNAME="0.0.0.0"` and `CMD ["node", "server.js"]`. Default PORT value:
  still NOT in the official docs. Station staff replies (per search snippets,
  not directly fetchable) sa…
  (https://github.com/railwayapp/docs/blob/main/content/docs/networking/troubleshooting/application-failed-to-respond.md
  ; https://github.com/railwayapp/docs/blob/main/content/guides/nextjs.md ;
  https://station.railway.com/questions/bug-report-port-env-variable-not-injec-8fe16b9c)

- **Healthchecks**  
  Configure them with `healthcheckPath` / `healthcheckTimeout` (CaC) or
  `healthcheck` / `healthcheckTimeout` (IaC). On deploy, Railway polls the path
  until it gets any 2xx response, then switches traffic. The default timeout is
  300 s; the variable `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` overrides it.
  Healthchecks run ONLY at deploy time, with no continuous monitoring. Requests
  come from hostname `healthcheck.railway.app`, so allow that host and keep the
  path free of auth redirects. A service with an attached volume gets brief
  downtime even with a healthcheck. The cron service should not need a
  healthcheck (inferred).  
  _Source (official-doc, high):_
  https://docs.railway.com/deployments/healthchecks _Verifier:_ CONFIRMED.
  Railway queries the endpoint until it gets any 2xx, then switches traffic. The
  default timeout is 300 seconds, overridable via settings or
  RAILWAY_HEALTHCHECK_TIMEOUT_SEC. 'Railway does not monitor the healthcheck
  endpoint after the deployment has gone live.' The hostname is
  `healthcheck.railway.app`. Services with attached volumes get a small amount
  of downtime even with a healthcheck. The healthcheck uses the PORT value. 'No
  healthcheck for cron' is inferred; it is not documented.
  (https://github.com/railwayapp/docs/blob/main/content/docs/deployments/healthchecks.md)

- **Custom domains and subdomains**  
  In Settings > Networking > Public Networking, use Generate Domain for
  `*.up.railway.app`, or + Custom Domain. In IaC:
  `domains: [{ domain: "app.example.com", port: 3000 }]`. DNS needs BOTH a CNAME
  (e.g. `xyz.up.railway.app`) AND a TXT ownership record. Without the TXT record
  the domain returns 404 even when the CNAME resolves. Let's Encrypt ECDSA
  certificates are issued automatically (90-day, renewed at 30 days left).
  Wildcards (`*.example.com`) need an extra `_acme-challenge` CNAME. Apex
  domains need CNAME flattening or ALIAS records (Route 53 and GoDaddy don't
  support this). With Cloudflare proxying, use SSL mode Full, not Full (Strict).
  Domain limits: Trial 1 total, Hobby 2 per service, Pro 20 per service. Each
  domain targets a specific internal port.  
  _Source (official-doc, high):_
  https://docs.railway.com/networking/domains/working-with-domains _Verifier:_
  CONFIRMED. A custom domain needs BOTH a CNAME and a TXT record: 'If the TXT
  record is missing, requests to your custom domain will return a 404 error even
  after the CNAME resolves.' Certificates are Let's Encrypt with ECDSA keys,
  'valid for 90 days and are automatically renewed when 30 days of validity
  remain.' Wildcards add an `_acme-challenge` CNAME. Apex domains need CNAME
  flattening or a dynamic ALIAS, and Route 53, Azure DNS, GoDaddy and
  Squarespace don't support that. With the Cloudflare proxy, use 'Full', not
  'Full (Strict)'. Limits: Trial 1, Hobby 2 per service, Pro 20 per service
  (raisable on request). Target ports map a domain to an internal port; the port
  is auto-detected when th…
  (https://github.com/railwayapp/docs/blob/main/content/docs/networking/domains/working-with-domains.md)

- **Railpack / Nixpacks support for pnpm workspaces**  
  Railpack is the default builder (latest tag v0.43.0). Nixpacks has been
  removed from the current docs: only RAILPACK and DOCKERFILE are documented
  builder values, and a Railway bot reply on Station says Nixpacks can't be
  selected. Railpack detects pnpm from the `packageManager` or
  `devEngines.packageManager` field, then from pnpm-lock.yaml, then from
  `engines.pnpm`, and supports workspaces through pnpm-workspace.yaml with no
  extra config. It runs `pnpm install --frozen-lockfile --prefer-offline`, then
  the root `build` script or the custom build command, and starts from the root
  `start` script, `main`, or index.js. To build or start one package, define
  root scripts, set the build/start commands (e.g.
  `pnpm --filter web... build`), or use railpack.json (`RAILPACK_CONFIG_FILE`)
  or `RAILPACK_BUILD_CMD` / `RAILPACK_START_CMD` / `RAILPACK_INSTALL_CMD`. It
  caches `.next/cache` per Next app and…  
  _Source (source-code, high):_ https://railpack.com/languages/node (source:
  https://github.com/railwayapp/railpack/blob/main/docs/src/content/docs/languages/node.md)
  ;
  https://github.com/railwayapp/railpack/blob/main/core/providers/node/package_manager.go
  ; https://docs.railway.com/config-as-code/reference _Verifier:_ CONFIRMED with
  nuances. The latest railpack tag is v0.43.0 (git ls-remote). The docs/ tree
  has zero Nixpacks references, after commit 3f8c829, 'Remove all Nixpacks
  references, replace with Railpack (#1076)', on 2026-03-07. The stale
  guides/nextjs.md still mentions Nixpacks. Package-manager detection order:
  packageManager field, then Mise (devEngines.packageManager / packageManager),
  then lockfiles (pnpm-lock.yaml), then engines.pnpm. pnpm workspaces come from
  pnpm-workspace.yaml. Nuance: `pnpm install --frozen-lockfile --prefer-offline`
  runs ONLY when pnpm-lock.yaml exists; otherwise it is plain `pnpm install`.
  Start command order: start script, then main, then index.js/index.ts. Caches:
  `.…
  (https://github.com/railwayapp/railpack/blob/main/docs/src/content/docs/languages/node.md
  ;
  https://github.com/railwayapp/railpack/blob/main/core/providers/node/package_manager.go
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/builds/build-configuration.md)

- **Pre-deploy command (migrations) semantics**  
  It runs between build and deploy, in a SEPARATE container built from the same
  image. It has the service's env vars and private-network access (so
  DATABASE_URL works), but NO volumes, and filesystem changes are not persisted.
  The command must exit 0. 'If your command fails, it will not be retried and
  the deployment will not proceed'; per the full-stack Next.js guide, the
  previous deployment keeps running. It also runs when the build is skipped. By
  default there is no time limit. The optional Pre-deploy Timeout is 1 to 3600
  s; it appears in the dashboard only after a command is entered and maps to
  `preDeployTimeoutSeconds` in the SDK/CLI. On timeout the container is removed
  and the deploy fails. It occupies a build-queue slot. Format: CaC
  `preDeployCommand: ["..."]` (array); IaC `preDeploy: "..."` (string or array).
  Migration tooling must be installed in the image. The docs don't say whet…  
  _Source (official-doc, high):_
  https://docs.railway.com/deployments/pre-deploy-command ;
  https://docs.railway.com/guides/fullstack-nextjs ;
  https://docs.railway.com/builds/skipped-builds _Verifier:_ CONFIRMED.
  Pre-deploy commands 'execute within your private network and have access to
  your application's environment variables'. 'If your command fails, it will not
  be retried and the deployment will not proceed.' The command runs 'in a
  separate container... Changes to the filesystem are not persisted and volumes
  are not mounted.' 'By default a pre-deploy command has no time limit.' The
  Pre-deploy Timeout is 1 to 3600 s, appears only after a command is entered,
  and on timeout 'its container is removed and the deployment fails'. It
  'occupies a slot in your build queue'. skipped-builds.md says pre-deploy
  commands 'execute even when the build is skipped'. fullstack-nextjs.md: 'If
  the migratio…
  (https://github.com/railwayapp/docs/blob/main/content/docs/deployments/pre-deploy-command.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/builds/skipped-builds.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/guides/fullstack-nextjs.md)

- **Railway-provided variables useful at runtime**  
  RAILWAY_PUBLIC_DOMAIN, RAILWAY_PRIVATE_DOMAIN, RAILWAY_TCP_PROXY_DOMAIN and
  RAILWAY_TCP_PROXY_PORT; RAILWAY_PROJECT_NAME/ID, RAILWAY_ENVIRONMENT_NAME/ID,
  RAILWAY_SERVICE_NAME/ID, RAILWAY_REPLICA_ID, RAILWAY_REPLICA_REGION,
  RAILWAY_DEPLOYMENT_ID and RAILWAY_SNAPSHOT_ID; and git variables
  RAILWAY_GIT_COMMIT_SHA, RAILWAY_GIT_BRANCH and others. Variables that
  configure Railway itself: RAILWAY_DOCKERFILE_PATH,
  RAILWAY_HEALTHCHECK_TIMEOUT_SEC, RAILWAY_DEPLOYMENT_OVERLAP_SECONDS,
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS, RAILWAY_RUN_UID and
  RAILWAY_SHM_SIZE_BYTES. A Dockerfile build sees variables only if they are
  declared with `ARG`.  
  _Source (official-doc, high):_ https://docs.railway.com/variables/reference ;
  https://docs.railway.com/builds/dockerfiles _Verifier:_ CONFIRMED.
  variables/reference.md lists RAILWAY_PUBLIC_DOMAIN, RAILWAY_PRIVATE_DOMAIN,
  RAILWAY_TCP_PROXY_DOMAIN/PORT, RAILWAY_TCP_APPLICATION_PORT,
  RAILWAY_PROJECT_NAME/ID, RAILWAY_ENVIRONMENT_NAME/ID, RAILWAY_SERVICE_NAME/ID,
  RAILWAY_REPLICA_ID, RAILWAY_REPLICA_REGION, RAILWAY_DEPLOYMENT_ID,
  RAILWAY_SNAPSHOT_ID, RAILWAY_VOLUME_NAME/MOUNT_PATH, and the RAILWAY_GIT_*
  variables (COMMIT_SHA, AUTHOR, BRANCH, REPO_NAME, REPO_OWNER, COMMIT_MESSAGE).
  The configuration variables are RAILWAY_DEPLOYMENT_OVERLAP_SECONDS,
  RAILWAY_DOCKERFILE_PATH (default 'Dockerfile'),
  RAILWAY_HEALTHCHECK_TIMEOUT_SEC, RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
  RAILWAY_RUN_UID and RAILWAY_SHM_SIZE_BYTES (default 64 MB). docke…
  (https://github.com/railwayapp/docs/blob/main/content/docs/variables/reference.md
  ;
  https://github.com/railwayapp/docs/blob/main/content/docs/builds/dockerfiles.md)

### Added by the verifier

- **MISSED: Next.js standalone output on Railpack in a pnpm monorepo — are
  static assets served?**  
  Not automatically. The Next.js docs say the standalone server.js 'does not
  copy the public or .next/static folders by default'. You must run
  `cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/`.
  In monorepos, set outputFileTracingRoot to the workspace root to trace shared
  packages, which nests server.js under the app's relative path inside
  .next/standalone (the nesting is inferred from the tracing-root behavior).
  Railpack's node provider has no standalone-specific handling (grep of
  core/providers/node shows none). So Railway's guide start script
  `node .next/standalone/server.js` alone would 404 static assets unless a build
  step copies them. A simpler alternative is `next start` with -p $PORT -H
  0.0.0.0.  
  _Source (source-code, medium):_
  https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/05-config/01-next-config-js/output.mdx
  ; https://github.com/railwayapp/railpack/tree/main/core/providers/node ;
  https://github.com/railwayapp/docs/blob/main/content/guides/nextjs.md

- **MISSED: Does `railway config migrate` or a manual migration require clearing
  the dashboard config-file path?**  
  Yes. Step 3 of the IaC doc's manual migration says: 'If the service uses a
  custom config file path in Railway, open the service's Settings, find the
  config file path field, and clear it.' `railway config migrate --apply`
  'Write[s] the file and clear[s] Railway Config File settings'. Greenfield
  services created by IaC never had CaC, so this matters only if someone sets a
  config path in the dashboard.  
  _Source (official-doc, high):_
  https://github.com/railwayapp/docs/blob/main/content/docs/infrastructure-as-code.md
  ; https://github.com/railwayapp/docs/blob/main/content/docs/cli/config.md

### Open questions

- The default value of the injected PORT is not documented. The IaC SDK's 8080
  default domain port suggests 8080, but this is unconfirmed, so set PORT
  explicitly.
- Whether a CRASHED cron run is restarted under the default ON_FAILURE restart
  policy is not documented. Recommend NEVER for the cron service, but confirm by
  watching `railway cron list`.
- Whether the pre-deploy command runs once per deployment or once per replica is
  not documented. Assume once per deployment, and make migrations idempotent and
  concurrency-safe (e.g. take an advisory lock).
- The exact contents of https://railway.com/railway.schema.json could not be
  fetched from this sandbox (DNS/proxy blocked). The key list comes from the
  docs plus the CLI/SDK source.
- IaC support for build.watchPatterns, dockerfilePath and builder exists in the
  SDK and CLI types. A Station thread reported gaps, so confirm with
  `railway config plan --show-values` before relying on them.
- The IaC reference example combines `rootDirectory: apps/api` with
  `pnpm --filter api build`, which contradicts the documented root-directory
  semantics for shared monorepos. Treat the example as unreliable for pnpm
  workspaces until tested.
- The docs still say JS monorepo auto-import 'detects railway.json/railway.toml
  at the package root', which contradicts 'New services cannot opt into Config
  as Code'. Assume the deprecation wins.
- Default injected PORT value: Railway staff replies on Station (seen only
  through search snippets; station.railway.com cannot be reached from this
  sandbox) say 8080. The official docs never state it. Set PORT explicitly and
  pass an explicit domain port in railway.ts.
- Whether a CRASHED cron run is restarted under the default ON_FAILURE policy is
  still undocumented. The cron run status list includes RESTARTING, which hints
  that restarts can apply.
- Whether the pre-deploy command runs once per deployment or once per replica is
  undocumented.
- Whether the backend actually honors build.watchPatterns, dockerfilePath and
  builder when they are applied through IaC was not verified end to end. The SDK
  and the CLI compiler pass them through unchanged.
- I could not fetch https://railway.com/railway.schema.json (railway.com and
  docs.railway.com are unreachable from WebFetch and curl). I verified docs
  content from the railwayapp/docs GitHub source at commit 7235449, dated
  2026-10-17.
- The '2026-08-28' date for new services no longer being able to opt into CaC
  comes only from search snippets of a Station staff reply. The docs give
  2026-12-01 only as the cutoff for existing files.

## Personal API keys (2026-10-23)

Checked on 2026-10-23 for the API-key mode (`LINEAR_AUTH=api_key`,
`docs/architecture.md` §4.1 and §7.4). The live developer site (`linear.app`,
`developers.linear.app`) still cannot be reached from the sandbox (WebFetch
ENOTFOUND, a proxy CONNECT 403 for curl). The sources used instead: Linear's own
documentation search (the Linear MCP's `search_documentation`, which returns the
docs pages' text), Linear's SDK source on GitHub, the vendored SDL at
`packages/linear/schema/linear.graphql` (@linear/sdk 98.0.0), search snippets of
the developer pages, local experiments, and the security review's own checks
(F12–F14). Where a fact is unverified the design does not depend on it.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                 | Source                                                                                                                                                                                                                                                    | Confidence                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| F1  | A personal API key is sent **raw** in `Authorization`, with no `Bearer` prefix; OAuth tokens use `Bearer <token>`. The SDK sends `Bearer <accessToken>` for an access token (unless it already starts with `Bearer `) and the bare `apiKey` otherwise.                                                                                                                                                                               | SDK source `packages/sdk/src/client.ts` lines 51–56 (raw.githubusercontent.com/linear/linear/master, fetched 2026-10-23); the developer docs' "pass the API key with header `Authorization: <API_KEY>`" (search snippet of linear.app/developers/graphql) | high (code)                      |
| F2  | Personal keys start `lin_api_`, OAuth tokens `lin_oauth_`, so `lin_(api\|oauth)_` covers every Linear credential the planner handles.                                                                                                                                                                                                                                                                                                | github.com/linear/linear-solutions `integration_guides/README.md` (already under "Token formats")                                                                                                                                                         | high                             |
| F3  | The body's length and alphabet after `lin_api_` are **unverified**; a third-party scanner rule uses `lin_api_[a-zA-Z0-9]{16,32}`. The planner accepts 16–200 URL-safe characters, one constant.                                                                                                                                                                                                                                      | docs.redhuntlabs.com (Linear API key rule)                                                                                                                                                                                                                | low                              |
| F4  | A key has "full access to the data your user can access" or chosen permissions (Read, Write, Admin, Create issues, Create comments), may be limited to teams; an admin's full-access key carries Admin rights; admins can stop members creating keys (Settings → Administration → API → Member API keys); keys are made in Settings → Account → Security & access.                                                                   | linear.app/docs/api-and-webhooks, linear.app/docs/security-and-access (documentation search text)                                                                                                                                                         | high                             |
| F5  | The API has **no** way to read a key's own permissions or teams (no `ApiKey` type, query or field) and **no** mutation that revokes a personal key, so the planner cannot revoke one on sign-out.                                                                                                                                                                                                                                    | the vendored SDL (only integration-specific `apiKey: String!` inputs)                                                                                                                                                                                     | high (SDK 98.0.0)                |
| F6  | `viewer` is the authenticated user and `organization` their workspace (`id`, `name`, `urlKey`): the identity query is the "whose key is this" check, and `UserFields` includes `guest`, `app` and `active`.                                                                                                                                                                                                                          | SDL; "Linear GraphQL schema" Q6 above; `packages/linear/src/queries.ts`                                                                                                                                                                                   | high                             |
| F7  | How Linear refuses a **Read-only key's** write (message, `extensions.code`, `type`) is **unverified**; most likely `type: "forbidden"`, which the client maps to `forbidden`. Whether Linear's error text can echo a credential is unverified.                                                                                                                                                                                       | SDK `packages/sdk/src/error.ts` (the type map)                                                                                                                                                                                                            | medium (type), unverified (text) |
| F8  | API keys: 2,500 requests/hour and 3,000,000 complexity points/hour **per user**, shared by all their keys; 10,000 points per query; the same rate-limit headers and `RATELIMITED` error as OAuth.                                                                                                                                                                                                                                    | search snippets of linear.app/developers/rate-limiting (an older page said 1,500/h and 250,000 points)                                                                                                                                                    | medium                           |
| F9  | `Query.rateLimitStatus.identifier` is "typically the API key or user ID": the planner never queries it (tested), since it could echo the key.                                                                                                                                                                                                                                                                                        | SDL (`rateLimitStatus`)                                                                                                                                                                                                                                   | high                             |
| F10 | Webhooks are managed in Settings → Administration → API and need admin permission; this mode turns webhooks off.                                                                                                                                                                                                                                                                                                                     | linear.app/docs/api-and-webhooks                                                                                                                                                                                                                          | high                             |
| F11 | Node 22 (undici) and Bun **echo an invalid header value in their error** (`Headers.append: "lin_api_bad\nvalue" is an invalid header value.`; `Header 'Authorization' has invalid value: …`), so the client refuses such a header before fetch. Fetch accepts `cache: 'no-store'`.                                                                                                                                                   | local runs (`node -e`, `bun -e`)                                                                                                                                                                                                                          | high                             |
| F12 | Railway's edge documents **`X-Real-IP`** as the client IP and says nothing about `X-Forwarded-For`, which a client can set; `X-Forwarded-Proto` is always `https`; a plain-HTTP GET gets a 301, a plain-HTTP POST becomes a GET after its body crossed in clear; HTTP logs hold method, path, host, `srcIp`, `clientUa` and timings, no bodies; tracing adds `OTEL_*` variables but exports nothing without an `instrumentation.ts`. | docs.railway.com/networking/public-networking/specs-and-limits (security review)                                                                                                                                                                          | high                             |
| F13 | `railway ssh` opens a shell in the running container (and `ssh -L` reaches its loopback); Node opens its inspector on `SIGUSR1` unless `--disable-sigusr1` (allowed in `NODE_OPTIONS`); Next 16.3.8's `next start` runs in-process, so the flag reaches the process holding the keys. A same-user shell can still read process memory by other means.                                                                                | docs.railway.com/cli/ssh; Node 22.22; `next/dist/cli/next-start.js` (security review)                                                                                                                                                                     | high                             |
| F14 | On a cross-origin 307, Node and Bun fetch drop `Authorization` but resend the POST body, so the client sets `redirect: 'error'`.                                                                                                                                                                                                                                                                                                     | local runs (security review)                                                                                                                                                                                                                              | high                             |

**Why `X-Real-IP` is the per-IP key.** The connect route's per-address limit
must count a person's tries, not whatever a client claims. Railway documents
`X-Real-IP` as the client address its edge saw; `X-Forwarded-For` is a list the
client can start, and Railway does not document whether it strips it. So the
limiter reads only `X-Real-IP` (a malformed or missing one shares one bucket)
and never `X-Forwarded-For`; a global window on failures that reached Linear
backs it up. On another host the operator must make sure `X-Real-IP` is set by
the proxy, or every client shares the no-IP bucket.

### Open questions

- The exact refusal Linear returns for a Read-only key's write (message,
  `extensions.code`, `type`), and for a team-restricted key writing to another
  team. Record both after the first real use; the read-only heuristic
  (`isKeyPermissionRefusal`) depends on the wording.
- The key body's format (length and alphabet after `lin_api_`), to tighten
  `LINEAR_API_KEY_SHAPE` if it is narrower than 16–200 URL-safe characters.
- Whether a team-restricted key can read `initiatives` (the mirror would then
  lack them when such a key is the reader).
- Whether Linear's error text can ever echo a credential. The client scrubs the
  exact credential and anything credential-shaped from every error either way.
