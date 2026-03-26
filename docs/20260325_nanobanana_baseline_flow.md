# 20260325 Nano Banana Baseline Flow

## Goal

Build a separate frontend baseline workflow that can be enabled by URL and compared against the current SAM3D flow.

This baseline should represent a Nano Banana image workflow, not the SAM3D native 3D-first workflow.

The baseline flow should be isolated from the current guided flow UI through a URL variable.

Recommended flag:

- `?baselineUi=nanobanana`

Default behavior stays unchanged:

- no `baselineUi` flag -> current SAM3D flow UI
- `?debugUi=true` -> current debug/operator UI
- `?baselineUi=nanobanana` -> Nano Banana baseline UI

## Backend Contract

Source of truth:

- [frontend-nanobanana-handoff.md](/d:/xrblocks/docs/frontend-nanobanana-handoff.md)

Current backend route for baseline generation:

- `POST /baseline/nanobanana/generate`
- `GET /jobs/{jobId}`
- `GET /baseline/{baselineId}/result`

Request shape:

```json
{
  "sessionId": "session-123",
  "workspaceId": "workspace-local",
  "prompt": "Create a realistic product image using these screenshots as references.",
  "images": [
    {
      "mimeType": "image/png",
      "dataUrl": "data:image/png;base64,..."
    }
  ],
  "options": {
    "numImages": 1,
    "aspectRatio": "auto",
    "outputFormat": "png",
    "limitGenerations": true
  }
}
```

Important implications:

- the frontend can send multiple images in one request
- the backend already supports a prompt plus multiple images
- the returned result is a generated image URL, not a 3D asset
- polling should reuse the same job pattern already used elsewhere in the frontend

## Proposed Baseline UX

We should treat the Nano Banana baseline as a separate staged workflow with image-first state.

Recommended stages:

1. `Reference Generate`
2. `Composite`
3. `3D Generate`

This keeps the comparison legible:

- our current tool: generate 3D objects directly and segment/compose them in 3D
- baseline: generate 2D reference images first, combine them into a final composite image, then convert that final image into 3D

## Stage 1: Reference Generate

Purpose:

- capture screenshot plus voice prompt
- send prompt + screenshot to Nano Banana
- let user generate as many reference images as they want

Recommended UX:

- keep the same capture and voice prompt pattern as the current generate phase
- screenshot should still be captured early and previewed
- after transcription finishes, user sees:
  - captured image preview
  - prompt text
  - `Confirm`
  - `Cancel`
  - `Re-record`
- on confirm:
  - send one-image Nano Banana request
  - poll job
  - show returned image in a results strip/gallery

Reference state to store locally:

- `referenceCaptures`: screenshots captured from the headset
- `referenceResults`: generated Nano Banana image results
- each result should include at least:
  - `baselineId`
  - `imageUrl`
  - `prompt`
  - `sourceCaptureDataUrl`
  - `savedAt`

UX notes:

- user should be able to generate multiple candidate images
- user should be able to browse/select among those results
- selected results from this stage become candidate inputs for composite

## Stage 2: Composite

Purpose:

- take one or more generated baseline images
- collect a new prompt
- send those images + prompt to Nano Banana again
- produce a single composite image

This uses the same backend route and the same request shape.

Only the frontend state changes:

- images come from Stage 1 Nano Banana outputs instead of raw headset screenshots

Recommended UX:

- show the current reference image set in a small gallery row
- assume all remaining reference images are included in the composite request
- let the user remove unwanted reference images with `Delete Image`
- provide a new prompt capture flow with the same confirmation pattern:
  - voice prompt
  - prompt preview
  - `Confirm`
  - `Cancel`
  - `Re-record`
- on confirm:
  - send all remaining generated images as `images[]`
  - send the composite prompt
  - poll job
  - show returned composite image

Important state:

- `compositePrompt`
- `compositeResult`
- current reference result list
- no per-image include toggle in the first version

Recommended output model:

- allow repeated composite attempts
- preserve a history of composite outputs
- let the user choose one final composite image as the candidate for 3D generation

## Stage 3: 3D Generate

Purpose:

- take the final chosen composite image
- use the existing 3D generation path from the SAM3D tool

Recommended behavior:

- do not invent a second 3D backend contract for the baseline
- reuse the current frontend 3D generation path wherever possible
- treat the chosen composite image as the image input to the existing SAM3D generation step

This means the baseline comparison becomes:

- Nano Banana image ideation / composition first
- SAM3D 3D generation second

## UI Separation

The Nano Banana baseline should not be mixed into the current flow panel.

Recommended routing:

- current flow UI remains the default
- baseline flow is activated only with `?baselineUi=nanobanana`
- debug UI remains separately available

Recommended runtime model:

- `uiShell = debug | sam3d-flow | nanobanana-flow`

This is preferable to blending baseline actions into the current SAM3D flow because:

- the comparison needs to be methodologically clear
- the mental model is different
- the state is different
- the baseline is image-centric, not object-centric

## Recommended Nano Banana UI Layout

A minimal version should use one stage-specific panel, similar to the current guided flow.

### Reference Generate panel

Primary controls:

- `Push To Talk`
- `Confirm`
- `Cancel`
- `Re-record`
- `Previous`
- `Next`
- `To Composite`
- optional `Delete Image`

Main content:

- latest captured screenshot preview
- prompt confirmation text
- generated image preview / gallery state

### Composite panel

Primary controls:

- `Push To Talk`
- `Confirm`
- `Cancel`
- `Re-record`
- `Previous`
- `Next`
- `To Generate`
- `To 3D`
- optional `Delete Image`

Main content:

- selected reference image gallery
- composite result preview
- current composite prompt text

### 3D Generate panel

Primary controls:

- reuse the current SAM3D generate handoff button path
- `To Composite`
- `Generate 3D`

Main content:

- chosen composite image preview
- generation status text

## Important Frontend State Model

Recommended baseline state object:

```ts
{
  mode: 'reference-generate' | 'composite' | '3d-generate',
  sessionId: string,
  workspaceId: string,
  latestCaptureDataUrl: string,
  referencePrompt: string,
  referenceResults: Array<{
    baselineId: string,
    imageUrl: string,
    prompt: string,
    sourceCaptureDataUrl: string,
    savedAt: number,
  }>,
  activeReferenceIndex: number,
  compositePrompt: string,
  compositeResults: Array<{
    baselineId: string,
    imageUrl: string,
    prompt: string,
    sourceReferenceIds: string[],
    savedAt: number,
  }>,
  activeCompositeIndex: number,
  chosenCompositeBaselineId: string | null,
}
```

## Reuse Opportunities

We should reuse as much as possible from the existing frontend:

- screenshot capture flow
- voice prompt recording
- prompt confirmation UI pattern
- polling helper pattern
- preview panel behavior
- Nano Banana prompt conditioning suffixes from [20260325_nanobanana_prompt_conditioning.md](/d:/xrblocks/docs/20260325_nanobanana_prompt_conditioning.md)
- status messaging
- previous/next navigation pattern
- cancel / confirm / re-record semantics

We should not reuse:

- segmentation state
- transform gizmos
- workspace asset state as the primary baseline model

Those belong to the SAM3D flow, not the baseline image workflow.

## Open Product Decisions

These are the main unresolved points before implementation:

1. Should the user be allowed to pass raw screenshots directly into Composite, or only Nano Banana outputs from Stage 1?

Recommended initial answer:

- only Stage 1 generated images

2. Should Composite allow multiple output attempts and browsing among them?

Recommended initial answer:

- yes

3. Should the final 3D Generate step create a normal SAM3D asset inside the same scene?

Recommended initial answer:

- yes

4. Should baseline state persist across reloads?

Recommended initial answer:

- no for the first implementation
- session-local state is enough

## Recommended Implementation Order

1. Add URL-gated Nano Banana flow shell
2. Implement Stage 1 reference generation with local result gallery
3. Implement Stage 2 composite generation from selected reference images
4. Implement Stage 3 handoff into the existing 3D generation path
5. Add minor polish only after the basic baseline loop is stable

## Practical Recommendation

For the first implementation, keep the baseline workflow intentionally narrow:

- one separate UI shell
- one gallery for reference images
- one gallery for composite images
- explicit stage transitions
- same confirm/cancel/re-record rhythm as the main tool

That will make the study comparison much cleaner than trying to hybridize the baseline into the existing SAM3D flow.




