import * as xb from 'xrblocks';

const STORAGE_KEY = 'xrblocks.sam3d_workspace.phase1';
const DEFAULT_MODEL_URL =
  'https://cdn.jsdelivr.net/gh/xrblocks/assets@main/models/Cat/cat.gltf';

function getUrlParamString(name, defaultValue = '') {
  const value = new URL(window.location.href).searchParams.get(name);
  return value ?? defaultValue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:') || !dataUrl.includes(',')) {
    return {
      mimeType: 'application/octet-stream',
      dataUrl: dataUrl || '',
    };
  }

  const [header] = dataUrl.split(',', 1);
  const mimeType = header.split(';', 1)[0].replace('data:', '');
  return {
    mimeType,
    dataUrl,
  };
}

export class Sam3dApiClient {
  constructor() {
    this.jobs = new Map();
    this.workspaceId = getUrlParamString('workspaceId', 'workspace-local');
    this.mockDelayMs = xb.getUrlParamFloat('mockDelayMs', 4000);
    this.mockModelUrl = getUrlParamString('mockModelUrl', DEFAULT_MODEL_URL);
    this.backendUrl = getUrlParamString('backendUrl', '').replace(/\/$/, '');
    this.artifactHint = getUrlParamString('artifactHint', '');
    this.useBackend = Boolean(this.backendUrl);
  }

  getStorageLabel() {
    if (!this.useBackend) {
      return 'local scaffold client';
    }

    try {
      const url = new URL(this.backendUrl);
      return `backend server (${url.host})`;
    } catch (_) {
      return 'backend server';
    }
  }

  async createGenerationJob({sessionId, prompt, image, artifactHint}) {
    if (this.useBackend) {
      const response = await fetch(`${this.backendUrl}/generate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId,
          workspaceId: this.workspaceId,
          prompt,
          image: parseDataUrl(image),
          artifactHint: (artifactHint ?? this.artifactHint) || undefined,
        }),
      });
      return await response.json();
    }

    const jobId = `job-${crypto.randomUUID()}`;
    const assetId = `asset-${crypto.randomUUID()}`;
    const latentHandle = `latent-${crypto.randomUUID()}`;

    this.jobs.set(jobId, {
      status: 'queued',
      progress: 0,
      result: {
        jobId,
        status: 'completed',
        sessionId,
        workspaceId: this.workspaceId,
        asset: {
          assetId,
          glbUrl: this.mockModelUrl,
          thumbnailUrl: image,
          latentHandle,
          metadata: {prompt},
        },
      },
    });

    this.runMockJob(jobId);

    return {
      jobId,
      status: 'queued',
      sessionId,
      workspaceId: this.workspaceId,
    };
  }

  async createNanobananaGenerationJob({sessionId, workspaceId = this.workspaceId, prompt, images = []}) {
    if (this.useBackend) {
      const response = await fetch(`${this.backendUrl}/baseline/nanobanana/generate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId,
          workspaceId,
          prompt,
          images: images.map((image) => parseDataUrl(image)),
          options: {
            numImages: 1,
            aspectRatio: 'auto',
            outputFormat: 'png',
            safetyTolerance: null,
            limitGenerations: true,
          },
        }),
      });
      return await response.json();
    }

    const jobId = `job-${crypto.randomUUID()}`;
    const baselineId = `baseline_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const imageUrl = images[0] || '';

    this.jobs.set(jobId, {
      status: 'queued',
      progress: 0,
      result: {
        jobId,
        status: 'completed',
        sessionId,
        workspaceId,
        baseline: {
          baselineId,
          imageUrl,
          savedAt: Date.now(),
          sourceType: 'nanobanana',
          metadata: {
            prompt,
            sessionId,
            workspaceId,
            jobId,
            provider: 'mock',
            model: 'mock-nanobanana',
            imageCount: images.length,
            outputs: imageUrl
              ? [
                  {
                    index: 0,
                    url: imageUrl,
                    fileName: 'mock-result.png',
                    contentType: parseDataUrl(imageUrl).mimeType,
                  },
                ]
              : [],
          },
        },
      },
    });

    this.runMockJob(jobId);

    return {
      jobId,
      status: 'queued',
      sessionId,
      workspaceId,
    };
  }

  async runMockJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'running';
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      await sleep(this.mockDelayMs / steps);
      const activeJob = this.jobs.get(jobId);
      if (!activeJob) return;
      activeJob.progress = i / steps;
      activeJob.message =
        i === steps ? 'Finalizing asset' : 'Mock SAM3D generation running';
    }

    const completedJob = this.jobs.get(jobId);
    if (!completedJob) return;
    completedJob.status = 'completed';
  }

  async listJobs() {
    if (this.useBackend) {
      const response = await fetch(`${this.backendUrl}/jobs`);
      return await response.json();
    }

    const items = [...this.jobs.entries()]
      .map(([jobId, job]) => ({jobId, status: job.status}))
      .reverse();

    return {items, count: items.length};
  }
  async getJob(jobId) {
    if (this.useBackend) {
      const response = await fetch(`${this.backendUrl}/jobs/${jobId}`);
      return await response.json();
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        jobId,
        status: 'failed',
        error: 'Unknown mock job id',
      };
    }

    if (job.status === 'completed') {
      return job.result;
    }

    return {
      jobId,
      status: job.status,
      progress: job.progress,
      message: job.message,
    };
  }

  async createComposeJob({sessionId, workspaceId, compose = {}}) {
    if (this.useBackend) {
      const response = await fetch(
        `${this.backendUrl}/workspaces/${workspaceId}/compose`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            sessionId,
            compose,
          }),
        }
      );
      return await response.json();
    }

    const jobId = `job-${crypto.randomUUID()}`;
    const assetId = `asset-${crypto.randomUUID()}`;
    const latentHandle = `latent-${crypto.randomUUID()}`;

    this.jobs.set(jobId, {
      status: 'queued',
      progress: 0,
      result: {
        jobId,
        status: 'completed',
        sessionId,
        workspaceId,
        asset: {
          assetId,
          glbUrl: this.mockModelUrl,
          thumbnailUrl: '',
          latentHandle,
          sourceType: 'composed',
          metadata: {
            workspaceId,
            sourceAssetIds: [],
          },
        },
      },
    });

    this.runMockJob(jobId);

    return {
      jobId,
      status: 'queued',
      sessionId,
      workspaceId,
    };
  }

  async saveWorkspace(workspace) {
    if (this.useBackend) {
      const response = await fetch(
        `${this.backendUrl}/workspaces/${this.workspaceId}/save`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            workspaceId: this.workspaceId,
            workspace,
          }),
        }
      );
      return await response.json();
    }

    const payload = {
      workspaceId: this.workspaceId,
      savedAt: Date.now(),
      workspace,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return payload;
  }

  async loadWorkspace() {
    if (this.useBackend) {
      const response = await fetch(
        `${this.backendUrl}/workspaces/${this.workspaceId}`
      );
      if (response.status === 404) {
        return null;
      }
      return await response.json();
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('Failed to parse saved SAM3D workspace.', error);
      return null;
    }
  }
}



