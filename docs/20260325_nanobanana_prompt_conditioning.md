# 20260325 Nano Banana Prompt Conditioning

## Goal

Define the fixed prompt-conditioning text that the frontend should append to user prompts for the Nano Banana baseline flow.

This conditioning should be used in:

- Stage 1: Reference Generate
- Stage 2: Composite

The purpose is to make the generated images better suited for later 3D generation in SAM3D and for backend mask extraction.

## Why This Exists

For the baseline flow, we do not want arbitrary image compositions.
We want outputs that behave more like clean object captures.

The main downstream requirement is:

- backend will use Python `rembg`
- masks should be easy to recover
- flat gray background makes this much more reliable

This means the frontend should always condition Nano Banana prompts so the model produces:

- a single dominant object or clean object grouping
- flat neutral gray background
- clean object silhouette separation
- stable lighting
- materials and shading that preserve object shape well for 3D generation

## Combination Rule

The frontend should combine prompts as:

```text
<user prompt>

<prompt condition suffix>
```

The conditioning text should not replace the user prompt.
It should be appended as a fixed suffix.

## Stage 1: Reference Generate

### Intent

Create a clean single-object reference image from headset screenshot context plus a user prompt.

### Fixed conditioning suffix

```text
Use the provided screenshot only as visual reference. Identify only the object requested by the prompt and isolate that object from the busy scene. Remove all other objects, desk clutter, background context, room context, text, labels, and extra props. Show a single centered object only against a flat neutral gray background with soft even studio lighting, realistic materials, full visibility, and a clean silhouette that is easy to separate from the background.
```

### Notes

This stage should strongly bias toward:

- one object
- centered framing
- full visibility
- neutral background separation

### Example final prompt

```text
Create a mug.

Use the provided screenshot only as visual reference. Identify only the object requested by the prompt and isolate that object from the busy scene. Remove all other objects, desk clutter, background context, room context, text, labels, and extra props. Show a single centered object only against a flat neutral gray background with soft even studio lighting, realistic materials, full visibility, and a clean silhouette that is easy to separate from the background.
```

## Stage 2: Composite

### Intent

Create one clean composite image from multiple reference images while preserving the same mask-friendly image conditions.

### Fixed conditioning suffix

```text
Create one clean composite image that combines the referenced objects into a single coherent arrangement. Keep all objects fully visible and unobstructed. Use a flat neutral gray background with no environment, no room context, no floor plane, no extra props, no text, and no labels. Use soft even studio lighting and realistic materials that preserve clear object boundaries and surface shape. The result should be easy to segment from the background for later 3D generation.
```

### Notes

This stage should still avoid:

- scenic backgrounds
- clutter
- dramatic lighting
- cast-shadow-heavy compositions
- decorative context objects

The point is not artistic realism.
The point is clean object presentation for later 3D processing.

### Example final prompt

```text
Arrange these objects as a compact desk set with balanced spacing.

Create one clean composite image that combines the referenced objects into a single coherent arrangement. Keep all objects fully visible and unobstructed. Use a flat neutral gray background with no environment, no room context, no floor plane, no extra props, no text, and no labels. Use soft even studio lighting and realistic materials that preserve clear object boundaries and surface shape. The result should be easy to segment from the background for later 3D generation.
```

## Backend Alignment

These prompt conditions are intentionally aligned with the backend plan:

- backend uses `rembg` to extract masks
- flat gray background improves reliability
- cleaner object boundaries improve SAM3D input quality

So this is not just visual style guidance.
It is part of the data contract between frontend prompting and backend preprocessing.

## Frontend Implementation Rule

Recommended constants:

- `NANOBANANA_REFERENCE_PROMPT_SUFFIX`
- `NANOBANANA_COMPOSITE_PROMPT_SUFFIX`

Recommended helper:

```ts
function buildConditionedNanobananaPrompt(userPrompt: string, stage: 'reference' | 'compose') {
  const suffix = stage === 'reference'
    ? NANOBANANA_REFERENCE_PROMPT_SUFFIX
    : NANOBANANA_COMPOSITE_PROMPT_SUFFIX;
  return `${userPrompt.trim()}\n\n${suffix}`;
}
```

## First-Version Recommendation

Keep the conditioning fully hardcoded in the frontend for now.

Do not make this editable in the UI yet.
That keeps the baseline comparison stable and methodologically consistent.
