# Standalone Preview Server

The Standalone Preview Server is an experimental way to render PrairieLearn questions and simulate
one assessment attempt directly from course files. It does not start PostgreSQL or the full
PrairieLearn application. Authoring tools can start one process with zero or more courses, create
Local Preview Sessions at runtime, and open session-scoped browser URLs.

The HTTP contract is versioned as `experimental-1`. It is a breaking replacement for the earlier
single-course proof of concept.

## Build and start

Build PrairieLearn before starting the compiled server:

```sh
pnpm --filter @prairielearn/prairielearn build
```

Start with no courses when an editor or integration will discover them later:

```sh
pnpm --filter @prairielearn/prairielearn preview:server
```

Start with one or more known courses by repeating `--course-dir`:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- \
  --course-dir /absolute/path/to/course-a \
  --course-dir /absolute/path/to/course-b
```

Each startup course creates a separate Local Preview Session. Two arguments that resolve to the
same canonical course directory still create two isolated sessions. Startup is atomic: if any
course is invalid, the process closes sessions it already created and fails instead of reporting
partial readiness.

The launch defaults are:

| Setting                     | Default         |
| --------------------------- | --------------- |
| Host                        | `127.0.0.1`     |
| Port                        | `4310`          |
| Render mode                 | `question-only` |
| Question timeout            | `5000` ms       |
| Worker execution mode       | `container`     |
| Worker count                | `1`             |
| Preview Workspaces          | disabled        |
| Workspace idle timeout      | `1800000` ms    |
| Running workspace maximum   | `3` server-wide |
| Workspace image pull policy | `missing`       |
| Workspace start timeout     | `60000` ms      |

Readiness output includes the listening origin and every startup Local Preview Session ID and
canonical course directory.

## Discover capabilities

`GET /health` is public and intentionally small:

```sh
curl http://127.0.0.1:4310/health
```

```json
{ "status": "ok" }
```

Use `GET /metadata` before assuming capabilities:

```sh
curl http://127.0.0.1:4310/metadata
```

Metadata reports `apiVersion: "experimental-1"`, the PrairieLearn package version, the session
endpoint, available and default render modes, grading, assessment-preview availability, Preview
Workspace availability and controls, the question timeout, worker count, and enabled workspace
limits. Check `features.assessmentPreview === true` before using the additive assessment routes;
an `experimental-1` server that omits the field still supports its question-preview contract.

## Optional control-plane authentication

Set `PRAIRIELEARN_PREVIEW_AUTH_TOKEN` in the server environment to protect metadata and Local
Preview Session management:

```sh
PRAIRIELEARN_PREVIEW_AUTH_TOKEN='replace-with-a-secret' \
  pnpm --filter @prairielearn/prairielearn preview:server
```

Then send the token as a bearer credential to `/metadata` and `/preview-sessions` operations:

```sh
curl -H 'Authorization: Bearer replace-with-a-secret' \
  http://127.0.0.1:4310/metadata
```

`GET /health` remains public. Browser routes below a Local Preview Session do not receive or
require the bearer token. The opaque Local Preview Session ID is the capability for that
session's browser content and resources, so do not expose it more broadly than the preview itself.
The bearer token is a control-plane credential; it must never be embedded in rendered HTML or
browser requests.

A Local Preview Session is not a hosted Quesal Preview Session and carries no Quesal user
authorization semantics.

## Create, list, reuse, and delete sessions

Create a session for an absolute course directory:

```sh
curl -X POST http://127.0.0.1:4310/preview-sessions \
  -H 'Content-Type: application/json' \
  -d '{"courseDir":"/absolute/path/to/course"}'
```

A successful response has status `201` and includes an opaque session ID plus the canonical course
directory:

```json
{
  "previewSessionId": "pvs_0123456789abcdefghijkl",
  "courseDir": "/canonical/path/to/course"
}
```

List sessions before deliberately reusing one:

```sh
curl http://127.0.0.1:4310/preview-sessions
```

Compare the returned canonical `courseDir` with the course your integration wants. The server does
not merge duplicate course sessions automatically and does not expire idle sessions.

Delete a session when its owner is finished:

```sh
curl -X DELETE \
  http://127.0.0.1:4310/preview-sessions/pvs_0123456789abcdefghijkl
```

The server removes the session from new routing immediately, drains accepted requests, closes its
Preview Workspace connections, and releases owned state before returning `204`.

Control-plane errors use a small JSON envelope with stable codes including `invalid_request`,
`unauthorized`, `invalid_course_dir`, `preview_session_not_found`, and
`capability_unavailable`. They do not include stack traces or PrairieLearn internals.

## Open a question

Question routes are scoped by Local Preview Session:

```text
GET /preview-sessions/<preview-session-id>/questions/<qid>?variant=<seed>&render-mode=<mode>
```

Encode each nested qid segment separately. For example, `topic/nested question` becomes:

```text
/preview-sessions/pvs_0123456789abcdefghijkl/questions/topic/nested%20question?variant=1
```

The variant defaults to seed `1`. Supplying the same seed regenerates the same deterministic
variant. Refresh reads current `info.json`, question templates, and executable question files, so
normal source edits do not require a server restart.

The server supports every Source Question Type:

- `v3` through PrairieLearn's Freeform pipeline.
- `Calculation`, `MultipleChoice`, `Checkbox`, `File`, and `MultipleTrueFalse` through the native
  legacy Calculation pipeline.

Course-specific legacy browser files and type-default files are supported through bounded,
traversal-safe resolution.

## Preview an assessment

Assessment preview is a database-free simulator for an author, not a local student account. It
creates one in-memory Assessment Preview Run for one synthetic attempt, presents one selected
question at a time, and discards the run with its Local Preview Session. The default
`question-only` mode can sample an assessment and navigate its selected question bodies, but it
cannot submit answers or finish-grade the run. Start in full render mode to exercise Internal
grading:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- --render-mode full
```

An assessment source locator has two course-relative values:

- `ciid` is the path below `courseInstances/` to the directory containing
  `infoCourseInstance.json`.
- `aid` is the path below that course instance's `assessments/` directory to the directory
  containing `infoAssessment.json`.

Both values may contain nested forward-slash-separated segments. The server rejects absolute
paths, empty segments, `.` or `..` segments, backslashes, NULs, and symlink escapes. Locator
validation operates on the decoded `ciid` and `aid` values. Consequently, a query-string client
may transmit a nested locator with the separator percent-encoded, for example
`ciid=2026%2Ffall&aid=module-one%2Fhomework-1`; normal query decoding turns those values into
`2026/fall` and `module-one/homework-1` before validation. In the JSON request below, write the
same separators as literal `/` characters.

This locator convention is distinct from asset-path validation. Asset URLs use literal `/`
characters between separately encoded path segments. An encoded `/` or backslash inside one asset
segment, such as `%2F` or `%5C`, is rejected rather than treated as another level of the asset path.

After creating a Local Preview Session, create or reuse a seeded run through its browser plane:

```sh
curl -X POST \
  http://127.0.0.1:4310/preview-sessions/pvs_0123456789abcdefghijkl/assessment-preview-runs \
  -H 'Content-Type: application/json' \
  -d '{"locator":{"ciid":"2026/fall","aid":"module-one/homework-1"},"seed":"1","reuse":true}'
```

The response identifies the run and returns the session-scoped document to open:

```json
{
  "assessmentPreviewRunId": "apr_0123456789abcdefghijkl",
  "seed": "1",
  "href": "/preview-sessions/pvs_0123456789abcdefghijkl/assessment-preview-runs/apr_0123456789abcdefghijkl/"
}
```

Open `href` on the same server origin. Use the links and forms in that document for run navigation
and grading instead of constructing child URLs. The Local Preview Session ID is the browser-plane
capability, so the optional control-plane bearer token is deliberately absent from this request and
from the rendered page.

The same assessment definition and seed reproduce the same pool and alternative selection. A
session owns at most one active run; requesting a different sample replaces its previous run.
Relevant assessment or question source changes invalidate the active run instead of mixing old
answers with new source. Create the sample again after editing. The Local Preview Extension does
this automatically on refresh and preserves the seed until the author selects **New sample**.

The simulator supports `Homework` and `Exam`, assessment text and scoped assets, seeded zone and
pool selection, assessment-configured question preferences, attempt and point policies, and
Internal grading through each question's native pipeline in full render mode. Modern
`accessControl` is evaluated only where local inputs are authoritative: the default rule at index
`0` and label-targeted trailing rules can use clearly simulated time, course roles, mode, labels,
and PrairieTest reservations. When `accessControl` is absent, preview uses an explicitly labeled
open local default. These limitations are intentional and visible in the run:

- Legacy assessment `allowAccess` is unsupported.
- Trailing student-specific `accessControl` rules without labels depend on enrollment targets
  created during database sync. Preview reports them as unsupported and does not apply them.
- Only local qids are resolved; shared questions are unsupported.
- Manual points, External grading, and AI-assisted/manual grading remain unresolved. A run that
  selects one of them reports an incomplete total instead of treating it as zero.
- Group membership and group-role view, submit, and navigation policies are unsupported. Preview
  reports configured group policies instead of inventing a group or role.
- Invalid assessment definitions detected by the database-free compiler block sampling and show
  structured diagnostics. Unsupported features may still produce a deliberately incomplete run.
- There is no real enrollment, roster, accommodation, PrairieTest orchestration, saved-answer
  history, second student or attempt, gradebook write, or production Exam security.
- The document is an authoring simulation, not an HTML or workflow replica of PrairieLearn's full
  assessment pages.

In the Local Preview Extension, open the assessment's exact `infoAssessment.json` file to select
the assessment target. The preview toolbar shows the stable sample seed; **New sample** rerolls the
seed. Opening another file below the assessment does not implicitly select that assessment.

## Render modes and Preview Answer Check

`question-only` is the default. It renders question bodies for embedding and does not show the
PrairieLearn card, title, grading button, answer panel, or submission panel. `POST` is unavailable
in this mode. An Assessment Preview Run can still be sampled, started, and navigated, but it cannot
accept answers or finish-grade until the server is restarted in full mode.

Start with full mode when the authoring experience needs Preview Answer Check:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- --render-mode full
```

A full server can narrow one request with `?render-mode=question-only`. A question-only server
cannot be upgraded by requesting `?render-mode=full`; the launch mode is a hard capability cap.

Preview Answer Check uses each Source Question Type's native browser contract:

- Freeform questions submit the ordinary form fields emitted by the page.
- Legacy questions submit the `postData` envelope emitted by the native legacy client. The server
  consumes only the submitted answer and regenerates authoritative variant state from the URL
  seed.

Answer checking and assessment finish-grading are available only for internally graded questions
in effective full mode. External and Manual grading are unavailable. On a standalone question
route, checking remains stateless: it does not create or join an Assessment Preview Run,
saved-answer history, or gradebook state. The separate assessment simulator described above keeps
only its active run in memory. Generated and submitted files remain available only in bounded
memory under the owning Local Preview Session.

## Resource URLs

PrairieLearn-owned immutable public assets remain global at their normal paths, including
`/assets/...` and required legacy Calculation modules under `/localscripts/calculationQuestion/...`.

Course assets, course-instance and assessment assets, question assets, declared legacy browser
files, generated files, submission files, and Preview Workspace resources are emitted below the
owning session:

```text
/preview-sessions/<id>/preview-render/clientFilesCourse/...
/preview-sessions/<id>/preview-render/questions/<qid>/files/...
/preview-sessions/<id>/preview-render/generatedFilesQuestion/variant/...
/preview-sessions/<id>/preview-render/question/.../submission/.../file/...
/preview-sessions/<id>/workspace/...
```

Rendered HTML already contains the correct scoped URLs. Integrations should proxy them unchanged
instead of rewriting completed HTML. Malformed encodings, encoded separators, dot segments, NULs,
backslashes, traversal, and symlink escapes are rejected before file lookup. Here, an encoded
separator means `%2F` or `%5C` inside a single asset-path segment; it does not refer to standard
query-string encoding of the `/` separators within an assessment locator value.

## Optional Preview Workspaces

Preview Workspaces are disabled by default, so ordinary preview does not require Docker. Enable
them explicitly:

```sh
pnpm --filter @prairielearn/prairielearn preview:server -- --workspaces
```

A workspace question emits its session-scoped workspace ID and URLs. Integrations do not create
workspace IDs themselves. A workspace belongs to one Local Preview Session and question/variant
pair; reopening the same pair reuses its files. Reboot and idle stop preserve files, while reset
regenerates them.

The running-container maximum is shared across all sessions. When capacity is needed, the globally
least recently active running workspace is stopped while its files remain. HTTP traffic and
heartbeats update the same activity clock.

Available workspace flags are:

- `--workspace-idle-timeout-ms <milliseconds>`
- `--workspace-max-containers <count>`
- `--workspace-pull-policy missing|always|never`
- `--workspace-start-timeout-ms <milliseconds>`
- `--workspace-home-dir <absolute-or-relative-path>`
- `--workspace-home-volume <named-volume>`
- `--workspace-network <docker-network>`

When the server itself runs in a container, use `--workspace-home-volume` so worker containers can
mount session-namespaced home subpaths, and attach the server and workspaces to the same
`--workspace-network`. Docker failure affects only a requested Preview Workspace; ordinary
question rendering remains available.

## Question-code workers and trust

The server owns one process-wide PrairieLearn engine and worker pool. `--workers-count` sets the
server-wide question-code concurrency limit.

The default `--workers-execution-mode container` runs executable question code in question-worker
containers and requires Docker. Use `--workers-execution-mode native` for local convenience when
Docker isolation is not wanted or available.

Both modes execute course and question code. Only preview courses you trust. Native mode runs that
code directly as your operating-system user. Container mode provides stronger filesystem and
process isolation, but it is not a trust boundary for unrestricted network access.

## Removed proof-of-concept behavior

The following unscoped routes are unavailable and return `404`:

- `/questions/*`
- `/preview-render/*`
- `/workspace/*`
- `/api/questions`

Use only routes below `/preview-sessions/<id>` for session-owned browser content.

The removed `--cache-type`, `--dev-mode`, and `--no-workspaces` options are rejected, as are unknown
flags, positional arguments, missing values, and invalid option values. Preview Workspaces now use
the positive, explicit `--workspaces` flag.
