# Frontend Handoff: Nano Banana Baseline Button

## Purpose

This note defines the current backend contract for the Nano Banana baseline image-generation flow.

The intent is:

- frontend collects a text prompt
- frontend collects one or more screenshot images as data URLs
- frontend sends them to the backend
- backend submits the request to fal.ai `fal-ai/nano-banana/edit`
- frontend polls the existing job route until completion
- frontend displays the returned generated image URL

This is a separate baseline workflow. It is not part of the SAM3D 3D asset generation contract.

## Backend Routes

The backend now exposes:

- `POST /baseline/nanobanana/generate`
- `GET /jobs/{jobId}`
- `GET /baseline/{baselineId}/result`

The frontend should use the same polling pattern it already uses for backend jobs.

## Generate Request

### Route

```text
POST /baseline/nanobanana/generate
```

### Request body

```json
{
  "sessionId": "session-123",
  "workspaceId": "workspace-local",
  "prompt": "Create a realistic product image using these screenshots as references.",
  "images": [
    {
      "mimeType": "image/png",
      "dataUrl": "data:image/png;base64,..."
    },
    {
      "mimeType": "image/png",
      "dataUrl": "data:image/png;base64,..."
    }
  ],
  "options": {
    "numImages": 1,
    "aspectRatio": "auto",
    "outputFormat": "png",
    "safetyTolerance": null,
    "limitGenerations": true
  }
}
```

### Required fields

- `prompt`: non-empty string
- `images`: array with at least one image
- each `images[i].dataUrl` must be a base64 `data:` URL

### Notes

- `mimeType` is accepted but the backend currently trusts the `dataUrl` as the source of truth.
- `sessionId` is optional. If omitted, the backend creates one.
- `workspaceId` defaults to `workspace-local` if omitted.
- `images` can contain multiple screenshots. This is the intended baseline flow.

## Options

Current backend-supported options are:

```json
{
  "numImages": 1,
  "aspectRatio": "auto",
  "outputFormat": "png",
  "safetyTolerance": null,
  "limitGenerations": true
}
```

### Semantics

- `numImages`: number of output images requested from the provider
- `aspectRatio`: passed through to fal.ai
- `outputFormat`: passed through to fal.ai
- `safetyTolerance`: optional pass-through string
- `limitGenerations`: passed through to fal.ai

For the first frontend button implementation, the recommended default payload is:

```json
{
  "numImages": 1,
  "aspectRatio": "auto",
  "outputFormat": "png",
  "limitGenerations": true
}
```

## Initial Response

The initial response is job-based and matches the existing backend pattern.

Example:

```json
{
  "jobId": "job-abc123",
  "status": "queued",
  "sessionId": "session-123",
  "workspaceId": "workspace-local"
}
```

The frontend should store `jobId` and then poll `GET /jobs/{jobId}`.

## Polling Response

### Route

```text
GET /jobs/{jobId}
```

While running, the backend will return statuses like:

- `queued`
- `running`
- `completed`
- `failed`

### Completed job example

```json
{
  "jobId": "job-abc123",
  "status": "completed",
  "progress": 1.0,
  "message": "Completed",
  "baseline": {
    "baselineId": "baseline_123abc",
    "imageUrl": "http://localhost:8000/baseline/baseline_123abc/result",
    "savedAt": 1774033762000,
    "sourceType": "nanobanana",
    "metadata": {
      "prompt": "Create a realistic product image using these screenshots as references.",
      "sessionId": "session-123",
      "workspaceId": "workspace-local",
      "jobId": "job-abc123",
      "provider": "fal",
      "model": "fal-ai/nano-banana/edit",
      "imageCount": 2,
      "requestId": "provider-request-id",
      "outputs": [
        {
          "index": 0,
          "url": "https://...",
          "fileName": "result.png",
          "contentType": "image/png",
          "width": 1024,
          "height": 1024
        }
      ],
      "description": "..."
    }
  }
}
```

### Failed job example

```json
{
  "jobId": "job-abc123",
  "status": "failed",
  "progress": 1.0,
  "message": "error text",
  "error": "error text",
  "completedAt": 1774033762000
}
```

## Final Image URL

The frontend should display:

- `job.baseline.imageUrl`

That URL is served by the backend route:

```text
GET /baseline/{baselineId}/result
```

The backend also persists the full run under `desktop-exp/backend/runs/{baselineId}`.

## Recommended Frontend Button Flow

The intended first implementation is:

1. User enters a baseline prompt.
2. User captures or selects one or more screenshot images.
3. Frontend converts those images into base64 `data:` URLs.
4. Frontend sends `POST /baseline/nanobanana/generate`.
5. Frontend polls `GET /jobs/{jobId}` every ~2 seconds.
6. On completion, frontend displays `baseline.imageUrl`.
7. On failure, frontend surfaces `error ?? message`.

## Minimal Fetch Example

```ts
async function generateNanobananaBaseline({
  baseUrl,
  sessionId,
  workspaceId,
  prompt,
  imageDataUrls,
}: {
  baseUrl: string;
  sessionId: string;
  workspaceId: string;
  prompt: string;
  imageDataUrls: string[];
}) {
  const res = await fetch(`${baseUrl}/baseline/nanobanana/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      workspaceId,
      prompt,
      images: imageDataUrls.map((dataUrl) => ({
        mimeType: "image/png",
        dataUrl,
      })),
      options: {
        numImages: 1,
        aspectRatio: "auto",
        outputFormat: "png",
        limitGenerations: true,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Nanobanana request failed: ${res.status}`);
  }

  const job = await res.json();
  return job.jobId as string;
}

async function pollBaselineJob(baseUrl: string, jobId: string) {
  while (true) {
    const res = await fetch(`${baseUrl}/jobs/${jobId}`);
    if (!res.ok) {
      throw new Error(`Job poll failed: ${res.status}`);
    }

    const job = await res.json();

    if (job.status === "completed") {
      return job.baseline;
    }

    if (job.status === "failed") {
      throw new Error(job.error || job.message || "Baseline generation failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
```

## Suggested UI Behavior

For the first button implementation, the frontend should keep the UI simple:

- one prompt text field
- one action button for baseline generation
- one screenshot list or multi-select capture source
- loading state while the job is queued/running
- image preview once `baseline.imageUrl` is available
- error text if the job fails

The frontend does not need its own persistence model for this first pass.
The backend already persists baseline run artifacts.

## Current Backend Notes

Important implementation facts:

- the backend submits to fal.ai model `fal-ai/nano-banana/edit`
- the backend supports multiple input screenshots in one request
- the backend serves the generated image back through its own `/baseline/{baselineId}/result` route
- the backend currently returns the first downloaded output image as the main display URL
- additional provider outputs are still recorded in `baseline.metadata.outputs`

## First Integration Goal

The first successful milestone is just:

- button can send prompt + multiple screenshots
- polling works
- generated image renders in the debug frontend

Do not overdesign the UI before that path works end to end.
