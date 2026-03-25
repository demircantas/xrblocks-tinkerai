# Frontend Handoff: Loading Queued Job Results

## Purpose

This note defines how the frontend should handle result loading for long-running backend jobs.

This now applies to:

- XR generation
- XR compose
- Nano Banana baseline generation

The backend now uses queued jobs for all of these flows.
The frontend should no longer assume that a successful `POST` means the result is immediately running or immediately available.

## Shared Job Rule

For all long-running routes:

- the initial `POST` returns a `jobId`
- the frontend must poll `GET /jobs/{jobId}`
- the frontend may also use `GET /jobs` to reconcile multiple pending jobs
- the frontend must branch on `job.status`

Current statuses:

- `queued`
- `running`
- `completed`
- `failed`

## Jobs Listing Route

The backend now also exposes:

```text
GET /jobs
```

Example response:

```json
{
  "items": [
    {
      "jobId": "job-003",
      "status": "completed"
    },
    {
      "jobId": "job-002",
      "status": "running"
    },
    {
      "jobId": "job-001",
      "status": "queued"
    }
  ],
  "count": 3
}
```

`GET /jobs` returns all persisted jobs, newest first.

This matters because the frontend can now create multiple queued jobs in a row.
If the frontend only tracks one active job id, later completed results can be missed in the UI even though the backend completed them correctly.

## Required Frontend Tracking Model

The frontend should track multiple jobs at once.

Minimum requirements:

- every new backend request adds a new `jobId`
- completed jobs are loaded exactly once
- handled jobs are not reloaded on the next poll

Recommended local state shape:

```ts
type PendingJobState = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  handled: boolean;
};
```

## Queue Fields

When a job is queued, the backend may return:

```json
{
  "jobId": "job-001",
  "status": "queued",
  "progress": 0.0,
  "message": "Queued for ...",
  "queuePosition": 1,
  "queueAhead": 0,
  "runningJobId": "job-other",
  "queueType": "xr",
  "queuedJobKind": "generate"
}
```

Frontend behavior:

- if `status === "queued"`, keep polling
- show a queued/loading UI state
- show `queuePosition` if available
- do not try to load the final asset or image yet

Recommended interpretation:

- `queuePosition = 1` means this job is next
- `queueAhead = 0` means no other queued jobs are ahead of it
- while queued, the frontend should keep polling and should not assume the first submitted job is the only one that matters

## XR Generation

### Start route

```text
POST /generate
```

### Completed job shape

```json
{
  "jobId": "job-001",
  "status": "completed",
  "asset": {
    "assetId": "asset-001",
    "glbUrl": "https://.../api/models/asset-001/mesh_0.glb",
    "thumbnailUrl": "data:image/png;base64,...",
    "latentHandle": "asset-001",
    "savedAt": 1774033762000,
    "sourceType": "generated",
    "hasLatents": true
  }
}
```

### Frontend load rule

When `status === "completed"`:

- read `job.asset`
- load the mesh from `job.asset.glbUrl`
- add the asset to the live workspace state
- persist `assetId`, `latentHandle`, and `glbUrl` in frontend workspace state as usual

Do not attempt to infer the asset by listing `/assets` first.
The completed job payload already contains the authoritative asset to load.

## XR Compose

### Start routes

```text
POST /compose
POST /workspaces/{workspaceId}/compose
```

### Completed job shape

```json
{
  "jobId": "job-002",
  "status": "completed",
  "asset": {
    "assetId": "asset-composed-001",
    "glbUrl": "https://.../api/models/asset-composed-001/mesh_0.glb",
    "latentHandle": "asset-composed-001",
    "savedAt": 1774033762000,
    "sourceType": "composed",
    "hasLatents": true
  }
}
```

### Frontend load rule

When `status === "completed"`:

- read `job.asset`
- load the composed mesh from `job.asset.glbUrl`
- add it to the live workspace like any other asset
- use `assetId` / `latentHandle` from the completed job payload

Do not wait for `/assets` catalog refresh before loading the result.
The completed job payload is sufficient.

## Nano Banana Baseline

### Start route

```text
POST /baseline/nanobanana/generate
```

### Completed job shape

```json
{
  "jobId": "job-003",
  "status": "completed",
  "baseline": {
    "baselineId": "baseline_123abc",
    "imageUrl": "http://localhost:8000/baseline/baseline_123abc/result",
    "savedAt": 1774033762000,
    "sourceType": "nanobanana"
  }
}
```

### Frontend load rule

When `status === "completed"`:

- read `job.baseline`
- display `job.baseline.imageUrl` directly in the UI
- do not try to reconstruct the image from provider output metadata

The backend already serves the generated image through:

```text
GET /baseline/{baselineId}/result
```

Use the returned `imageUrl` as the canonical display URL.

## Polling Pattern

Recommended frontend polling loop:

1. submit the request
2. store `jobId`
3. poll either:
   - `GET /jobs/{jobId}` for each pending job, or
   - `GET /jobs` and reconcile all pending/completed jobs
4. handle states:
   - `queued`: show queue state, keep polling
   - `running`: show running state, keep polling
   - `completed`: load the returned result immediately
   - `failed`: show `error ?? message`

For any frontend that can trigger multiple requests quickly, `GET /jobs` reconciliation is the safer pattern.

## Minimal Result Loader Example

```ts
type BackendJob = any;

async function pollJobUntilFinished(baseUrl: string, jobId: string): Promise<BackendJob> {
  while (true) {
    const res = await fetch(`${baseUrl}/jobs/${jobId}`);
    if (!res.ok) {
      throw new Error(`Job poll failed: ${res.status}`);
    }

    const job = await res.json();

    if (job.status === "completed") {
      return job;
    }

    if (job.status === "failed") {
      throw new Error(job.error || job.message || "Backend job failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function loadCompletedJobResult(job: any) {
  if (job.asset?.glbUrl) {
    return {
      kind: "asset",
      asset: job.asset,
      url: job.asset.glbUrl,
    };
  }

  if (job.baseline?.imageUrl) {
    return {
      kind: "image",
      baseline: job.baseline,
      url: job.baseline.imageUrl,
    };
  }

  throw new Error("Completed job did not contain a loadable result");
}
```

## Recommended Multi-Job Reconciliation Pattern

```ts
async function reconcileJobs(baseUrl: string, handledJobIds: Set<string>) {
  const res = await fetch(`${baseUrl}/jobs`);
  if (!res.ok) {
    throw new Error(`Jobs list failed: ${res.status}`);
  }

  const payload = await res.json();
  const jobs = Array.isArray(payload.items) ? payload.items : [];

  for (const job of jobs) {
    if (job.status !== "completed") continue;
    if (handledJobIds.has(job.jobId)) continue;

    const fullRes = await fetch(`${baseUrl}/jobs/${job.jobId}`);
    if (!fullRes.ok) continue;

    const fullJob = await fullRes.json();
    const result = loadCompletedJobResult(fullJob);

    if (result.kind === "asset") {
      // add result.asset to workspace and load result.url
    } else if (result.kind === "image") {
      // display result.url
    }

    handledJobIds.add(job.jobId);
  }
}
```

## UI Recommendation

For each pending job card or panel, the frontend should show:

- job kind if known
- current `status`
- `message`
- queue metadata when queued
- progress if present

When completed:

- XR jobs: show a button or automatic flow that loads the returned `glbUrl`
- Nano Banana jobs: show the returned image immediately

## Most Important Implementation Rule

The frontend should treat the completed job payload as the source of truth for loading the result.

That means:

- XR: load `job.asset.glbUrl`
- Nano Banana: load `job.baseline.imageUrl`

Do not depend on a later catalog refresh to discover the result before showing it to the user.

Also:

- do not depend on a single global active job
- do not assume only the first queued request needs to be handled
- do reconcile multiple completed jobs and load each exactly once
