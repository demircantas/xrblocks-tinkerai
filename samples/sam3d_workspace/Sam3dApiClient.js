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
    return this.useBackend ? 'mock backend' : 'local scaffold client';
  }

  async createGenerationJob({sessionId, prompt, image}) {
    if (this.useBackend) {
      const response = await fetch(`${this.backendUrl}/generate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId,
          workspaceId: this.workspaceId,
          prompt,
          image: parseDataUrl(image),
          artifactHint: this.artifactHint || undefined,
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



