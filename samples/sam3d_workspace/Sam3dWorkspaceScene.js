import * as THREE from 'three';
import * as xb from 'xrblocks';

import {Sam3dApiClient} from './Sam3dApiClient.js';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PROMPT = 'Generate this coffee mug';
const OVERLAY_ON_CAMERA = xb.getUrlParamBool('overlayOnCamera', false);

function getUrlParamString(name, defaultValue = '') {
  const value = new URL(window.location.href).searchParams.get(name);
  return value ?? defaultValue;
}

function matrixToArray(object3D) {
  object3D.updateMatrix();
  return object3D.matrix.toArray();
}

export class Sam3dWorkspaceScene extends xb.Script {
  constructor() {
    super();
    this.apiClient = new Sam3dApiClient();
    this.sessionId = `session-${crypto.randomUUID()}`;
    this.currentPrompt = getUrlParamString('prompt', DEFAULT_PROMPT);
    this.lastScreenshotDataUrl = '';
    this.currentJobId = null;
    this.currentAssetRecord = null;
    this.activeModelViewer = null;
    this.pollHandle = null;
    this.isRecordingPrompt = false;
  }

  init() {
    xb.core.input.addReticles();
    this.addLights();
    this.createWorkspaceUI();
    this.bindSpeechRecognizer();
    this.refreshPromptText();
    this.setStatus(
      'Ready. Capture a screenshot, record a prompt, and generate an asset.'
    );
  }

  addLights() {
    this.add(new THREE.HemisphereLight(0xbbbbbb, 0x777788, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(0, 3, -1);
    this.add(light);
  }

  createWorkspaceUI() {
    this.panel = new xb.SpatialPanel({
      width: 1.2,
      height: 1.0,
      backgroundColor: '#111827F0',
      useDefaultPosition: false,
    });
    this.panel.isRoot = true;
    this.panel.position.set(0, xb.user.height + 0.05, -1.0);
    this.add(this.panel);

    const grid = this.panel.addGrid();

    grid.addRow({weight: 0.12}).addText({
      text: 'SAM3D Workspace',
      fontSize: 0.065,
      fontColor: '#d1fae5',
    });

    this.statusText = grid.addRow({weight: 0.1}).addText({
      text: 'Initializing...',
      fontSize: 0.04,
      fontColor: '#fde68a',
      anchorX: 'left',
    });

    this.promptText = grid.addRow({weight: 0.12}).addText({
      text: '',
      fontSize: 0.04,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      anchorY: 'top',
    });

    const actionsRow = grid.addRow({weight: 0.14});
    const captureButton = actionsRow.addCol({weight: 0.25}).addTextButton({
      text: 'Capture',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSize: 0.05,
    });
    captureButton.onTriggered = () => this.captureScreenshot();

    this.recordButton = actionsRow.addCol({weight: 0.25}).addTextButton({
      text: 'Record Prompt',
      backgroundColor: '#7c2d12',
      fontColor: '#ffffff',
      fontSize: 0.043,
    });
    this.recordButton.onTriggered = () => this.togglePromptRecording();

    const generateButton = actionsRow.addCol({weight: 0.25}).addTextButton({
      text: 'Generate',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSize: 0.05,
    });
    generateButton.onTriggered = () => this.generateAsset();

    const resetButton = actionsRow.addCol({weight: 0.25}).addTextButton({
      text: 'Reset',
      backgroundColor: '#4b5563',
      fontColor: '#ffffff',
      fontSize: 0.05,
    });
    resetButton.onTriggered = () => this.resetWorkspace();

    const previewRow = grid.addRow({weight: 0.34});
    this.previewImage = previewRow.addImage({
      src: '',
      paddingX: 0.03,
      paddingY: 0.03,
    });

    const saveLoadRow = grid.addRow({weight: 0.14});
    const saveButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Save Workspace',
      backgroundColor: '#065f46',
      fontColor: '#ffffff',
      fontSize: 0.046,
    });
    saveButton.onTriggered = () => this.saveWorkspace();

    const loadButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Load Workspace',
      backgroundColor: '#4338ca',
      fontColor: '#ffffff',
      fontSize: 0.046,
    });
    loadButton.onTriggered = () => this.loadWorkspace();

    grid.addRow({weight: 0.08}).addText({
      text: 'Phase 1 scaffold: screenshot, prompt, job polling, editable asset, save/load.',
      fontSize: 0.032,
      fontColor: '#9ca3af',
      anchorX: 'left',
    });

    this.panel.updateLayouts();
  }

  bindSpeechRecognizer() {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus('Speech recognition unavailable. Use the default prompt.');
      return;
    }

    recognizer.addEventListener('result', (event) => {
      const {transcript, isFinal} = event;
      this.currentPrompt = transcript || this.currentPrompt;
      this.refreshPromptText();
      if (isFinal) {
        this.isRecordingPrompt = false;
        this.updateRecordButton();
        this.setStatus('Prompt captured. You can generate now.');
      }
    });

    recognizer.addEventListener('error', (event) => {
      this.isRecordingPrompt = false;
      this.updateRecordButton();
      this.setStatus(`Speech error: ${event.error}`);
    });

    recognizer.addEventListener('end', () => {
      this.isRecordingPrompt = false;
      this.updateRecordButton();
    });
  }

  refreshPromptText() {
    if (this.promptText) {
      this.promptText.text = `Prompt: ${this.currentPrompt}`;
    }
  }

  updateRecordButton() {
    if (!this.recordButton) return;
    this.recordButton.text = this.isRecordingPrompt
      ? 'Stop Recording'
      : 'Record Prompt';
  }

  setStatus(text) {
    if (this.statusText) {
      this.statusText.text = text;
    }
  }

  async captureScreenshot() {
    this.setStatus('Capturing screenshot...');
    try {
      const useCameraOverlay = OVERLAY_ON_CAMERA && !!xb.core.deviceCamera;
      const image = await xb.core.screenshotSynthesizer.getScreenshot(
        useCameraOverlay
      );
      this.lastScreenshotDataUrl = image;
      this.previewImage.load(image);
      this.setStatus(
        useCameraOverlay
          ? 'Camera-overlay screenshot captured.'
          : 'Scene screenshot captured.'
      );
    } catch (error) {
      console.error('Failed to capture screenshot.', error);
      this.setStatus('Screenshot capture failed.');
    }
  }

  togglePromptRecording() {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus('Speech recognition is unavailable in this browser.');
      return;
    }

    if (this.isRecordingPrompt) {
      recognizer.stop();
      this.isRecordingPrompt = false;
      this.setStatus('Stopped listening for prompt.');
    } else {
      this.isRecordingPrompt = true;
      this.setStatus('Listening for prompt...');
      recognizer.start();
    }
    this.updateRecordButton();
  }

  async generateAsset() {
    if (!this.lastScreenshotDataUrl) {
      this.setStatus('Capture a screenshot before generating.');
      return;
    }

    if (!this.currentPrompt) {
      this.setStatus('Provide a prompt before generating.');
      return;
    }

    if (this.currentJobId) {
      this.setStatus('A generation job is already running.');
      return;
    }

    const job = await this.apiClient.createGenerationJob({
      sessionId: this.sessionId,
      prompt: this.currentPrompt,
      image: this.lastScreenshotDataUrl,
    });

    this.currentJobId = job.jobId;
    this.setStatus(`Job queued: ${job.jobId}`);
    this.startPollingJob(job.jobId);
  }

  startPollingJob(jobId) {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }

    this.pollHandle = setInterval(async () => {
      const update = await this.apiClient.getJob(jobId);
      if (update.status === 'running' || update.status === 'queued') {
        const progress = update.progress
          ? `${Math.round(update.progress * 100)}%`
          : 'starting';
        this.setStatus(
          `Generation ${update.status}: ${progress}${
            update.message ? ` - ${update.message}` : ''
          }`
        );
        return;
      }

      clearInterval(this.pollHandle);
      this.pollHandle = null;
      this.currentJobId = null;

      if (update.status === 'failed') {
        this.setStatus(update.error || 'Generation failed.');
        return;
      }

      await this.loadGeneratedAsset(update.asset);
    }, POLL_INTERVAL_MS);
  }

  async loadGeneratedAsset(asset) {
    this.setStatus('Loading generated asset...');

    if (this.activeModelViewer) {
      this.remove(this.activeModelViewer);
      this.activeModelViewer = null;
    }

    const model = new xb.ModelViewer({});
    this.add(model);

    const {path, model: modelName} = this.splitAssetUrl(asset.glbUrl);
    await model.loadGLTFModel({
      data: {
        path,
        model: modelName,
        scale: {x: 0.9, y: 0.9, z: 0.9},
      },
      renderer: xb.core.renderer,
    });
    model.position.set(0, 0.78, -1.1);

    this.activeModelViewer = model;
    this.currentAssetRecord = {
      assetId: asset.assetId,
      latentHandle: asset.latentHandle,
      glbUrl: asset.glbUrl,
      prompt: asset.metadata?.prompt || this.currentPrompt,
      transform: matrixToArray(model),
      thumbnailUrl: asset.thumbnailUrl || this.lastScreenshotDataUrl,
    };

    this.setStatus('Generated asset loaded. Drag to move and rotate in XR.');
  }

  splitAssetUrl(url) {
    const lastSlash = url.lastIndexOf('/') + 1;
    return {
      path: url.slice(0, lastSlash),
      model: url.slice(lastSlash),
    };
  }

  buildWorkspaceSnapshot() {
    if (!this.activeModelViewer || !this.currentAssetRecord) {
      return {
        assets: [],
      };
    }

    return {
      assets: [
        {
          assetId: this.currentAssetRecord.assetId,
          latentHandle: this.currentAssetRecord.latentHandle,
          glbUrl: this.currentAssetRecord.glbUrl,
          prompt: this.currentAssetRecord.prompt,
          thumbnailUrl: this.currentAssetRecord.thumbnailUrl,
          transform: matrixToArray(this.activeModelViewer),
          selections: [],
        },
      ],
    };
  }

  async saveWorkspace() {
    const workspace = this.buildWorkspaceSnapshot();
    await this.apiClient.saveWorkspace(workspace);
    if (workspace.assets.length === 0) {
      this.setStatus('Workspace saved with no assets yet.');
      return;
    }
    this.setStatus('Workspace saved locally through the scaffold client.');
  }

  async loadWorkspace() {
    const saved = await this.apiClient.loadWorkspace();
    if (!saved?.workspace?.assets?.length) {
      this.setStatus('No saved workspace found.');
      return;
    }

    const asset = saved.workspace.assets[0];
    await this.loadGeneratedAsset({
      assetId: asset.assetId,
      glbUrl: asset.glbUrl,
      thumbnailUrl: asset.thumbnailUrl,
      latentHandle: asset.latentHandle,
      metadata: {prompt: asset.prompt},
    });
    this.applyTransformToActiveModel(asset.transform);
    if (asset.thumbnailUrl) {
      this.lastScreenshotDataUrl = asset.thumbnailUrl;
      this.previewImage.load(asset.thumbnailUrl);
    }
    this.currentPrompt = asset.prompt || this.currentPrompt;
    this.refreshPromptText();
    this.setStatus('Workspace restored from the scaffold client save.');
  }

  applyTransformToActiveModel(transformArray) {
    if (!this.activeModelViewer || !transformArray) return;
    const matrix = new THREE.Matrix4().fromArray(transformArray);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    this.activeModelViewer.position.copy(position);
    this.activeModelViewer.quaternion.copy(quaternion);
    this.activeModelViewer.scale.copy(scale);
    this.activeModelViewer.updateMatrix();
  }

  resetWorkspace() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.currentJobId = null;
    this.currentAssetRecord = null;
    this.lastScreenshotDataUrl = '';
    this.previewImage.load('');
    if (this.activeModelViewer) {
      this.remove(this.activeModelViewer);
      this.activeModelViewer = null;
    }
    this.setStatus('Workspace reset.');
  }
}


