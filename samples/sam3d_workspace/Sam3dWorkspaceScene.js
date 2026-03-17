import * as THREE from 'three';
import * as xb from 'xrblocks';

import {Sam3dApiClient} from './Sam3dApiClient.js';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PROMPT = 'Generate this coffee mug';
const OVERLAY_ON_CAMERA = xb.getUrlParamBool('overlayOnCamera', false);
const SAMPLE_VERSION = 'ui-refactor-v1';

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
    this.updateMicDiagnostics();
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
      width: 0.92,
      height: 1.08,
      backgroundColor: '#1f2937EE',
      useDefaultPosition: false,
    });
    this.panel.isRoot = true;
    this.panel.position.set(0, xb.user.height + 0.02, -0.95);
    this.add(this.panel);

    const grid = this.panel.addGrid();

    grid.addRow({weight: 0.08}).addText({
      text: 'SAM3D Workspace',
      fontSizeDp: 28,
      fontColor: '#d1fae5',
    });

    this.statusText = grid.addRow({weight: 0.08}).addText({
      text: 'Initializing...',
      fontSizeDp: 18,
      fontColor: '#fde68a',
      anchorX: 'left',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
    });

    this.promptText = grid.addRow({weight: 0.1}).addText({
      text: '',
      fontSizeDp: 18,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const controlsHeaderRow = grid.addRow({weight: 0.05});
    controlsHeaderRow.addText({
      text: 'Controls',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const actionsRowTop = grid.addRow({weight: 0.11});
    const captureButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Capture',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    captureButton.onTriggered = () => this.captureScreenshot();

    this.recordButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Record',
      backgroundColor: '#9a3412',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    this.recordButton.onTriggered = () => this.togglePromptRecording();

    const generateButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Generate',
      backgroundColor: '#2563eb',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    generateButton.onTriggered = () => this.generateAsset();

    const actionsRowBottom = grid.addRow({weight: 0.11});
    const resetButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Reset',
      backgroundColor: '#6b7280',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    resetButton.onTriggered = () => this.resetWorkspace();

    this.testMicButton = actionsRowBottom
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Test Mic',
        backgroundColor: '#b45309',
        fontColor: '#ffffff',
        fontSizeDp: 18,
        opacity: 0.98,
        width: 0.82,
        height: 0.62,
      });
    this.testMicButton.onTriggered = () => this.runMicCapabilityTest();

    const loadButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Load',
      backgroundColor: '#7c3aed',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    loadButton.onTriggered = () => this.loadWorkspace();

    const diagnosticsHeaderRow = grid.addRow({weight: 0.05});
    diagnosticsHeaderRow.addText({
      text: 'Diagnostics',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const micRow = grid.addRow({weight: 0.1});
    this.micDiagnosticsText = micRow.addText({
      text: 'Mic diagnostics: checking...',
      fontSizeDp: 15,
      fontColor: '#fbcfe8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
    });

    const previewHeaderRow = grid.addRow({weight: 0.05});
    previewHeaderRow.addText({
      text: 'Latest Capture',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const previewFrameRow = grid.addRow({weight: 0.28});
    const previewFrame = previewFrameRow.addPanel({
      backgroundColor: '#0f172acc',
      height: 0.92,
      width: 0.94,
      showEdge: true,
    });
    const previewGrid = previewFrame.addGrid();
    previewGrid.addRow({weight: 1.0});
    this.previewImage = previewGrid.addImage({
      src: '',
      paddingX: 0.04,
      paddingY: 0.04,
    });
    previewFrame.updateLayouts();

    const saveLoadRow = grid.addRow({weight: 0.11});
    const saveButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Save Workspace',
      backgroundColor: '#065f46',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    saveButton.onTriggered = () => this.saveWorkspace();

    const clearButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Clear Preview',
      backgroundColor: '#374151',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    clearButton.onTriggered = () => {
      this.lastScreenshotDataUrl = '';
      this.previewImage.load('');
      this.setStatus('Screenshot preview cleared.');
    };

    grid.addRow({weight: 0.09}).addText({
      text:
        'Version: ' + SAMPLE_VERSION + '\n' +
        'Phase 1 scaffold for screenshot, prompt, mic diagnostics, job polling, and asset preview.',
      fontSizeDp: 12,
      fontColor: '#94a3b8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
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
      this.updateMicDiagnostics(`Speech error: ${event.error}`);
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

  updateMicDiagnostics(extraMessage = '') {
    if (!this.micDiagnosticsText) return;
    const hasMediaDevices = !!navigator.mediaDevices?.getUserMedia;
    const hasSpeechRecognition =
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    const recognizerReady = !!xb.core.sound.speechRecognizer;

    const summary =
      `Mic API: ${hasMediaDevices ? 'yes' : 'no'} | ` +
      `Speech API: ${hasSpeechRecognition ? 'yes' : 'no'} | ` +
      `Recognizer: ${recognizerReady ? 'yes' : 'no'}`;

    this.micDiagnosticsText.text = extraMessage
      ? `${summary}\n${extraMessage}`
      : summary;
  }

  updateRecordButton() {
    if (!this.recordButton) return;
    this.recordButton.text = this.isRecordingPrompt ? 'Stop' : 'Record';
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
      this.updateMicDiagnostics('No recognizer instance is available.');
      return;
    }

    if (this.isRecordingPrompt) {
      recognizer.stop();
      this.isRecordingPrompt = false;
      this.setStatus('Stopped listening for prompt.');
    } else {
      this.isRecordingPrompt = true;
      this.updateMicDiagnostics('Speech recognizer start requested.');
      this.setStatus('Listening for prompt...');
      recognizer.start();
    }
    this.updateRecordButton();
  }

  async runMicCapabilityTest() {
    this.setStatus('Requesting microphone access...');
    this.updateMicDiagnostics('Testing microphone access...');

    if (!navigator.mediaDevices?.getUserMedia) {
      this.updateMicDiagnostics('getUserMedia is not available in this browser.');
      this.setStatus('Microphone API is unavailable.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const trackLabels = stream
        .getAudioTracks()
        .map((track) => track.label || 'unlabeled-track');
      stream.getTracks().forEach((track) => track.stop());

      const labelSummary =
        trackLabels.length > 0 ? trackLabels.join(', ') : 'audio track opened';
      this.updateMicDiagnostics(`Mic test passed: ${labelSummary}`);
      this.setStatus(
        'Microphone access succeeded. Speech API may still be unsupported.'
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown mic test failure';
      this.updateMicDiagnostics(`Mic test failed: ${message}`);
      this.setStatus(`Microphone test failed: ${message}`);
    }
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
    this.updateMicDiagnostics();
    this.setStatus('Workspace reset.');
  }
}
