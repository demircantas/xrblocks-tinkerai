import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import {Keyboard} from 'xrblocks/addons/virtualkeyboard/Keyboard.js';

import {Sam3dApiClient} from './Sam3dApiClient.js';
import {MeshSelectionController} from './MeshSelectionController.js';
import {TransformGizmoController} from './TransformGizmoController.js';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PROMPT = 'Generate this coffee mug';
const OVERLAY_ON_CAMERA = xb.getUrlParamBool('overlayOnCamera', false);
const DEBUG_UI = xb.getUrlParamBool('debugUi', false);
const USE_DESKTOP_GEMINI_CAPTURE = xb.getUrlParamBool(
  'useDesktopGeminiCapture',
  false
);
const DESKTOP_GEMINI_CAPTURE_URL = '../../assets/desktop_gemini.png';
const SAMPLE_VERSION = 'workspace-selection-v1';
const USER_CAPTURE_PREVIEW_MS = 4000;
const TRANSFORM_TRANSLATE_STEP = 0.05;
const TRANSFORM_ROTATE_STEP = THREE.MathUtils.degToRad(15);
const TRANSFORM_SCALE_MULTIPLIER = 1.1;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function getUrlParamString(name, defaultValue = '') {
  const value = new URL(window.location.href).searchParams.get(name);
  return value ?? defaultValue;
}

function matrixToArray(object3D) {
  object3D.updateMatrix();
  return object3D.matrix.toArray();
}

function matrixWorldToArray(object3D) {
  object3D.updateMatrixWorld(true);
  return object3D.matrixWorld.toArray();
}

function normalizeTransformMatrix(assetRecord) {
  return assetRecord?.transformMatrix || assetRecord?.transform || null;
}

async function loadImageAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch test capture: ${response.status}`);
  }

  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read test capture blob.'));
    reader.readAsDataURL(blob);
  });
}

export class Sam3dWorkspaceScene extends xb.Script {
  constructor() {
    super();
    this.apiClient = new Sam3dApiClient();
    this.sessionId = `session-${crypto.randomUUID()}`;
    this.debugUiEnabled = DEBUG_UI;
    this.userFlowMode = DEBUG_UI ? null : 'generate';
    this.userFlowWorkspaceId = null;
    this.userFlowAwaitingPromptConfirmation = false;
    this.recordingPurpose = 'prompt';
    this.confirmationTranscript = '';
    this.userCapturePreviewTimer = null;
    this.currentPrompt = getUrlParamString('prompt', DEFAULT_PROMPT);
    this.lastScreenshotDataUrl = '';
    this.currentJobId = null;
    this.pollHandle = null;
    this.pollGeneration = 0;
    this.isRecordingPrompt = false;
    this.isPromptEditorOpen = false;
    this.promptKeyboard = null;
    this.assetInstances = new Map();
    this.assetDerivedViews = new Map();
    this.catalogItems = [];
    this.catalogIndex = 0;
    this.workspaceCatalogItems = [];
    this.workspaceCatalogIndex = 0;
    this.activeAssetId = null;
    this.selectionController = null;
    this.transformGizmoController = null;
    this.isSelectionMode = false;
    this.environmentTarget = null;
    this.environmentTexture = null;
    this.previousEnvironment = null;
    this.workspaceState = this.createEmptyWorkspaceState();
  }

  createEmptyWorkspaceState() {
    return {
      sessionId: this.sessionId,
      prompt: this.currentPrompt,
      lastScreenshotDataUrl: this.lastScreenshotDataUrl,
      assets: [],
    };
  }

  init() {
    xb.core.input.addReticles();
    this.setupEnvironmentLighting();
    this.addLights();
    this.createWorkspaceUI();
    this.createPromptKeyboard();
    this.createSelectionController();
    this.createTransformGizmoController();
    this.bindSpeechRecognizer();
    this.updateMicDiagnostics();
    this.refreshPromptText();
    this.updateSelectionUi();
    this.refreshCatalogUi();
    this.refreshWorkspaceCatalogUi();
    this.setDebugPanelVisibility(this.debugUiEnabled);
    this.updateUserFlowUi();
    this.setStatus(
      this.debugUiEnabled
        ? USE_DESKTOP_GEMINI_CAPTURE
          ? 'Ready. Capture will use assets/desktop_gemini.png for testing.'
          : 'Ready. Capture a screenshot, record a prompt, or edit it manually.'
        : 'Generate mode. Use push-to-talk to describe the object you want to generate.'
    );
  }

  setupEnvironmentLighting() {
    if (!xb.core?.renderer || !xb.core?.scene || this.environmentTexture) return;

    this.previousEnvironment = xb.core.scene.environment || null;
    const pmrem = new THREE.PMREMGenerator(xb.core.renderer);
    pmrem.compileEquirectangularShader();
    this.environmentTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.environmentTexture = this.environmentTarget.texture;
    xb.core.scene.environment = this.environmentTexture;
    pmrem.dispose();
  }

  addLights() {
    this.add(new THREE.AmbientLight(0xffffff, 0.35));
    this.add(new THREE.HemisphereLight(0xbbbbbb, 0x777788, 0.8));
  }

  createWorkspaceUI() {
    this.mainPanel = new xb.SpatialPanel({
      width: 0.62,
      height: 0.92,
      backgroundColor: '#1f2937EE',
      useDefaultPosition: false,
    });
    this.mainPanel.isRoot = true;
    this.mainPanel.position.set(-0.36, xb.user.height + 0.03, -0.9);
    this.add(this.mainPanel);

    const mainGrid = this.mainPanel.addGrid();

    mainGrid.addRow({weight: 0.08}).addText({
      text: 'SAM3D Workspace',
      fontSizeDp: 26,
      fontColor: '#d1fae5',
    });

    this.statusText = mainGrid.addRow({weight: 0.1}).addText({
      text: 'Initializing...',
      fontSizeDp: 17,
      fontColor: '#fde68a',
      anchorX: 'left',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
    });

    this.promptText = mainGrid.addRow({weight: 0.13}).addText({
      text: '',
      fontSizeDp: 17,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const promptActionsRow = mainGrid.addRow({weight: 0.1});
    const editPromptButton = promptActionsRow.addCol({weight: 1 / 3}).addTextButton({
      text: 'Edit Prompt',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.86,
      height: 0.56,
    });
    editPromptButton.onTriggered = () => this.togglePromptEditor();

    const backspacePromptButton = promptActionsRow.addCol({weight: 1 / 3}).addTextButton({
      text: 'Backspace',
      backgroundColor: '#7c2d12',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.86,
      height: 0.56,
    });
    backspacePromptButton.onTriggered = () => this.removeLastPromptCharacter();

    const defaultPromptButton = promptActionsRow.addCol({weight: 1 / 3}).addTextButton({
      text: 'Use Default',
      backgroundColor: '#475569',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.86,
      height: 0.56,
    });
    defaultPromptButton.onTriggered = () => this.restoreDefaultPrompt();

    mainGrid.addRow({weight: 0.05}).addText({
      text: 'Core Actions',
      fontSizeDp: 15,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const actionsRowTop = mainGrid.addRow({weight: 0.11});
    const captureButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Capture',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    captureButton.onTriggered = () => this.captureScreenshot();

    this.recordButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Record',
      backgroundColor: '#9a3412',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    this.recordButton.onTriggered = () => this.togglePromptRecording();

    const generateButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Generate',
      backgroundColor: '#2563eb',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    generateButton.onTriggered = () => this.generateAsset();

    const actionsRowBottom = mainGrid.addRow({weight: 0.11});
    const resetButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Reset',
      backgroundColor: '#6b7280',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    resetButton.onTriggered = () => this.resetWorkspace();

    this.testMicButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Test Mic',
      backgroundColor: '#b45309',
      fontColor: '#ffffff',
      fontSizeDp: 16,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    this.testMicButton.onTriggered = () => this.runMicCapabilityTest();

    const clearButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Clear Preview',
      backgroundColor: '#374151',
      fontColor: '#ffffff',
      fontSizeDp: 16,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    clearButton.onTriggered = () => {
      this.lastScreenshotDataUrl = '';
      this.workspaceState.lastScreenshotDataUrl = '';
      this.previewImage.load('');
      this.setStatus('Screenshot preview cleared.');
    };

    mainGrid.addRow({weight: 0.05}).addText({
      text: 'Latest Capture',
      fontSizeDp: 15,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const previewFrameRow = mainGrid.addRow({weight: 0.26});
    const previewFrame = previewFrameRow.addPanel({
      backgroundColor: '#0f172acc',
      height: 0.94,
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

    this.micDiagnosticsText = mainGrid.addRow({weight: 0.11}).addText({
      text: 'Mic diagnostics: checking...',
      fontSizeDp: 14,
      fontColor: '#fbcfe8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
    });

    mainGrid.addRow({weight: 0.08}).addText({
      text: 'Version: ' + SAMPLE_VERSION,
      fontSizeDp: 12,
      fontColor: '#94a3b8',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    this.mainPanel.updateLayouts();

    this.selectionPanel = new xb.SpatialPanel({
      width: 0.48,
      height: 0.54,
      backgroundColor: '#111827EE',
      useDefaultPosition: false,
    });
    this.selectionPanel.isRoot = true;
    this.selectionPanel.position.set(0.34, xb.user.height + 0.22, -0.82);
    this.add(this.selectionPanel);

    const selectionGrid = this.selectionPanel.addGrid();
    selectionGrid.addRow({weight: 0.12}).addText({
      text: 'Selection Tools',
      fontSizeDp: 22,
      fontColor: '#d1fae5',
    });

    const selectionRow = selectionGrid.addRow({weight: 0.22});
    this.selectionModeButton = selectionRow.addCol({weight: 1 / 3}).addTextButton({
      text: 'Select: OFF',
      backgroundColor: '#374151',
      fontColor: '#ffffff',
      fontSizeDp: 16,
      opacity: 0.98,
      width: 0.84,
      height: 0.62,
    });
    this.selectionModeButton.onTriggered = () => this.toggleSelectionMode();

    this.paintModeButton = selectionRow.addCol({weight: 1 / 3}).addTextButton({
      text: 'Mode: Drop',
      backgroundColor: '#991b1b',
      fontColor: '#ffffff',
      fontSizeDp: 16,
      opacity: 0.98,
      width: 0.84,
      height: 0.62,
    });
    this.paintModeButton.onTriggered = () => this.togglePaintMode();

    this.previewSelectionButton = selectionRow.addCol({weight: 1 / 3}).addTextButton({
      text: 'Preview',
      backgroundColor: '#166534',
      fontColor: '#ffffff',
      fontSizeDp: 16,
      opacity: 0.98,
      width: 0.84,
      height: 0.62,
    });
    this.previewSelectionButton.onTriggered = () => this.previewSelection();

    const selectionActionsRow = selectionGrid.addRow({weight: 0.18});
    this.clearSelectionButton = selectionActionsRow.addCol({weight: 0.5}).addTextButton({
      text: 'Reset Keep',
      backgroundColor: '#4b5563',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.clearSelectionButton.onTriggered = () => this.clearSelection();

    this.toggleKeptOnlyButton = selectionActionsRow.addCol({weight: 0.5}).addTextButton({
      text: 'View: Full',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.toggleKeptOnlyButton.onTriggered = () => this.toggleActiveAssetViewMode();

    selectionGrid.addRow({weight: 0.1}).addText({
      text: 'Selection edits apply to the active asset only.',
      fontSizeDp: 13,
      fontColor: '#94a3b8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
    });

    this.selectionPanel.updateLayouts();

    this.transformPanel = new xb.SpatialPanel({
      width: 0.44,
      height: 0.62,
      backgroundColor: '#0f172aEE',
      useDefaultPosition: false,
    });
    this.transformPanel.isRoot = true;
    this.transformPanel.position.set(-0.01, xb.user.height - 0.22, -0.82);
    this.add(this.transformPanel);

    const transformGrid = this.transformPanel.addGrid();
    transformGrid.addRow({weight: 0.12}).addText({
      text: 'Transform',
      fontSizeDp: 22,
      fontColor: '#e2e8f0',
    });

    this.transformAssetText = transformGrid.addRow({weight: 0.16}).addText({
      text: 'No active asset selected.',
      fontSizeDp: 14,
      fontColor: '#cbd5e1',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const activeAssetRow = transformGrid.addRow({weight: 0.16});
    this.transformPrevAssetButton = activeAssetRow.addCol({weight: 0.5}).addTextButton({
      text: 'Prev Asset',
      backgroundColor: '#334155',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.transformPrevAssetButton.onTriggered = () => this.stepActiveAsset(-1);

    this.transformNextAssetButton = activeAssetRow.addCol({weight: 0.5}).addTextButton({
      text: 'Next Asset',
      backgroundColor: '#334155',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.transformNextAssetButton.onTriggered = () => this.stepActiveAsset(1);

    const translateRow = transformGrid.addRow({weight: 0.16});
    this.moveXNegativeButton = translateRow.addCol({weight: 0.25}).addTextButton({
      text: 'X-',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.moveXNegativeButton.onTriggered = () => this.translateActiveAsset(-TRANSFORM_TRANSLATE_STEP, 0, 0);

    this.moveXPositiveButton = translateRow.addCol({weight: 0.25}).addTextButton({
      text: 'X+',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.moveXPositiveButton.onTriggered = () => this.translateActiveAsset(TRANSFORM_TRANSLATE_STEP, 0, 0);

    this.moveZNegativeButton = translateRow.addCol({weight: 0.25}).addTextButton({
      text: 'Z-',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.moveZNegativeButton.onTriggered = () => this.translateActiveAsset(0, 0, -TRANSFORM_TRANSLATE_STEP);

    this.moveZPositiveButton = translateRow.addCol({weight: 0.25}).addTextButton({
      text: 'Z+',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.moveZPositiveButton.onTriggered = () => this.translateActiveAsset(0, 0, TRANSFORM_TRANSLATE_STEP);

    const transformRow = transformGrid.addRow({weight: 0.16});
    this.moveYPositiveButton = transformRow.addCol({weight: 0.25}).addTextButton({
      text: 'Y+',
      backgroundColor: '#7c3aed',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.moveYPositiveButton.onTriggered = () => this.translateActiveAsset(0, TRANSFORM_TRANSLATE_STEP, 0);

    this.moveYNegativeButton = transformRow.addCol({weight: 0.25}).addTextButton({
      text: 'Y-',
      backgroundColor: '#7c3aed',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.moveYNegativeButton.onTriggered = () => this.translateActiveAsset(0, -TRANSFORM_TRANSLATE_STEP, 0);

    this.rotateNegativeButton = transformRow.addCol({weight: 0.25}).addTextButton({
      text: 'Yaw -',
      backgroundColor: '#b45309',
      fontColor: '#ffffff',
      fontSizeDp: 14,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.rotateNegativeButton.onTriggered = () => this.rotateActiveAsset(-TRANSFORM_ROTATE_STEP);

    this.rotatePositiveButton = transformRow.addCol({weight: 0.25}).addTextButton({
      text: 'Yaw +',
      backgroundColor: '#b45309',
      fontColor: '#ffffff',
      fontSizeDp: 14,
      opacity: 0.98,
      width: 0.76,
      height: 0.56,
    });
    this.rotatePositiveButton.onTriggered = () => this.rotateActiveAsset(TRANSFORM_ROTATE_STEP);

    const scaleRow = transformGrid.addRow({weight: 0.16});
    this.scaleDownButton = scaleRow.addCol({weight: 0.5}).addTextButton({
      text: 'Scale -',
      backgroundColor: '#475569',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.scaleDownButton.onTriggered = () => this.scaleActiveAsset(1 / TRANSFORM_SCALE_MULTIPLIER);

    this.scaleUpButton = scaleRow.addCol({weight: 0.5}).addTextButton({
      text: 'Scale +',
      backgroundColor: '#475569',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.scaleUpButton.onTriggered = () => this.scaleActiveAsset(TRANSFORM_SCALE_MULTIPLIER);

    transformGrid.addRow({weight: 0.14}).addText({
      text: 'Wrapper-only debug transforms: world-space X/Y/Z, world-yaw, uniform scale.',
      fontSizeDp: 12,
      fontColor: '#94a3b8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    this.transformPanel.updateLayouts();

    this.libraryPanel = new xb.SpatialPanel({
      width: 0.48,
      height: 0.98,
      backgroundColor: '#172554EE',
      useDefaultPosition: false,
    });
    this.libraryPanel.isRoot = true;
    this.libraryPanel.position.set(0.34, xb.user.height - 0.26, -0.82);
    this.add(this.libraryPanel);

    const libraryGrid = this.libraryPanel.addGrid();
    libraryGrid.addRow({weight: 0.12}).addText({
      text: 'Asset Catalog',
      fontSizeDp: 22,
      fontColor: '#dbeafe',
    });

    this.catalogText = libraryGrid.addRow({weight: 0.28}).addText({
      text: 'Catalog: loading...',
      fontSizeDp: 14,
      fontColor: '#cbd5e1',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const catalogButtonsTop = libraryGrid.addRow({weight: 0.18});
    this.catalogPrevButton = catalogButtonsTop.addCol({weight: 0.33}).addTextButton({
      text: 'Prev',
      backgroundColor: '#334155',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.catalogPrevButton.onTriggered = () => this.stepCatalog(-1);

    this.catalogNextButton = catalogButtonsTop.addCol({weight: 0.33}).addTextButton({
      text: 'Next',
      backgroundColor: '#334155',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.catalogNextButton.onTriggered = () => this.stepCatalog(1);

    this.catalogRefreshButton = catalogButtonsTop.addCol({weight: 0.34}).addTextButton({
      text: 'Refresh',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.catalogRefreshButton.onTriggered = () => this.refreshAssetCatalog();

    const catalogButtonsBottom = libraryGrid.addRow({weight: 0.18});
    this.catalogLoadButton = catalogButtonsBottom.addCol({weight: 0.5}).addTextButton({
      text: 'Load Asset',
      backgroundColor: '#7c3aed',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.catalogLoadButton.onTriggered = () => this.loadCatalogAsset();

    this.catalogDeleteButton = catalogButtonsBottom.addCol({weight: 0.5}).addTextButton({
      text: 'Delete Asset',
      backgroundColor: '#991b1b',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    this.catalogDeleteButton.onTriggered = () => this.deleteSelectedCatalogAsset();

    libraryGrid.addRow({weight: 0.12}).addText({
      text: 'Catalog buttons operate on backend assets. Save/Load WS operate on workspaces.',
      fontSizeDp: 13,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    libraryGrid.addRow({weight: 0.1}).addText({
      text: 'Workspace Catalog',
      fontSizeDp: 18,
      fontColor: '#dbeafe',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    this.workspaceStatusText = libraryGrid.addRow({weight: 0.08}).addText({
      text: 'Current WS: ' + this.apiClient.workspaceId,
      fontSizeDp: 13,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    this.workspaceCatalogText = libraryGrid.addRow({weight: 0.18}).addText({
      text: 'Workspace catalog: press Refresh WS.',
      fontSizeDp: 14,
      fontColor: '#cbd5e1',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const workspaceButtonsTop = libraryGrid.addRow({weight: 0.15});
    this.workspaceCatalogPrevButton = workspaceButtonsTop.addCol({weight: 0.33}).addTextButton({
      text: 'Prev WS',
      backgroundColor: '#334155',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.workspaceCatalogPrevButton.onTriggered = () => this.stepWorkspaceCatalog(-1);

    this.workspaceCatalogNextButton = workspaceButtonsTop.addCol({weight: 0.33}).addTextButton({
      text: 'Next WS',
      backgroundColor: '#334155',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.workspaceCatalogNextButton.onTriggered = () => this.stepWorkspaceCatalog(1);

    this.workspaceCatalogRefreshButton = workspaceButtonsTop.addCol({weight: 0.34}).addTextButton({
      text: 'Refresh WS',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.workspaceCatalogRefreshButton.onTriggered = () => this.refreshWorkspaceCatalog();

    const workspaceButtonsBottom = libraryGrid.addRow({weight: 0.14});
    this.workspaceSnapshotButton = workspaceButtonsBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Snapshot WS',
      backgroundColor: '#065f46',
      fontColor: '#ffffff',
      fontSizeDp: 14,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.workspaceSnapshotButton.onTriggered = () => this.saveWorkspace();

    this.workspaceCatalogLoadButton = workspaceButtonsBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Load WS',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: 14,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.workspaceCatalogLoadButton.onTriggered = () => this.loadSelectedWorkspaceCatalogItem();

    this.workspaceCatalogDeleteButton = workspaceButtonsBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Delete WS',
      backgroundColor: '#991b1b',
      fontColor: '#ffffff',
      fontSizeDp: 14,
      opacity: 0.98,
      width: 0.82,
      height: 0.58,
    });
    this.workspaceCatalogDeleteButton.onTriggered = () => this.deleteSelectedWorkspaceCatalogItem();

    const workspaceButtonsCompose = libraryGrid.addRow({weight: 0.14});
    this.workspaceComposeButton = workspaceButtonsCompose.addCol({weight: 1}).addTextButton({
      text: 'Compose WS',
      backgroundColor: '#7c3aed',
      fontColor: '#ffffff',
      fontSizeDp: 15,
      opacity: 0.98,
      width: 0.9,
      height: 0.58,
    });
    this.workspaceComposeButton.onTriggered = () => this.composeSelectedWorkspaceCatalogItem();    this.libraryPanel.updateLayouts();

    this.userFlowPanel = new xb.SpatialPanel({
      width: 0.54,
      height: 0.86,
      backgroundColor: '#111827EE',
      useDefaultPosition: false,
    });
    this.userFlowPanel.isRoot = true;
    this.userFlowPanel.position.set(0, xb.user.height, -0.82);
    this.add(this.userFlowPanel);

    const userGrid = this.userFlowPanel.addGrid();
    this.userFlowModeText = userGrid.addRow({weight: 0.1}).addText({
      text: 'Generate',
      fontSizeDp: 24,
      fontColor: '#dbeafe',
    });

    this.userFlowDetailText = userGrid.addRow({weight: 0.14}).addText({
      text: '',
      fontSizeDp: 16,
      fontColor: '#e5e7eb',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    this.userFlowStatusText = userGrid.addRow({weight: 0.14}).addText({
      text: '',
      fontSizeDp: 15,
      fontColor: '#fde68a',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const userPreviewRow = userGrid.addRow({weight: 0.22});
    this.userFlowPreviewPanel = userPreviewRow.addPanel({
      backgroundColor: '#0f172acc',
      height: 0.94,
      width: 0.94,
      showEdge: true,
    });
    const userPreviewGrid = this.userFlowPreviewPanel.addGrid();
    userPreviewGrid.addRow({weight: 1.0});
    this.userFlowPreviewImage = userPreviewGrid.addImage({
      src: '',
      paddingX: 0.04,
      paddingY: 0.04,
    });
    this.userFlowPreviewPanel.visible = false;
    this.userFlowPreviewPanel.updateLayouts();

    this.userFlowButtons = [];
    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
      const row = userGrid.addRow({weight: 0.1});
      for (let colIndex = 0; colIndex < 2; colIndex++) {
        const button = row.addCol({weight: 0.5}).addTextButton({
          text: '',
          backgroundColor: '#1f2937',
          fontColor: '#ffffff',
          fontSizeDp: 15,
          opacity: 0.98,
          width: 0.88,
          height: 0.58,
        });
        button.visible = false;
        button.onTriggered = () => {};
        this.userFlowButtons.push(button);
      }
    }

    userGrid.addRow({weight: 0.1}).addText({
      text: 'Use ?debugUi=true to open the full operator panels.',
      fontSizeDp: 12,
      fontColor: '#94a3b8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    this.userFlowPanel.updateLayouts();
  }

  setDebugPanelVisibility(visible) {
    this.mainPanel.visible = visible;
    this.selectionPanel.visible = visible;
    this.transformPanel.visible = visible;
    this.libraryPanel.visible = visible;
    this.userFlowPanel.visible = !visible;
  }

  configureUserFlowButton(index, {
    text = '',
    backgroundColor = '#1f2937',
    onTriggered = () => {},
    visible = true,
  } = {}) {
    const button = this.userFlowButtons?.[index];
    if (!button) return;
    button.text = text;
    button.backgroundColor = backgroundColor;
    button.onTriggered = onTriggered;
    button.visible = visible;
  }

  getActiveAssetOrdinalText() {
    if (!this.workspaceState.assets.length || !this.activeAssetId) {
      return 'No active asset.';
    }
    const index = this.workspaceState.assets.findIndex(
      (asset) => asset.assetId === this.activeAssetId
    );
    return index >= 0
      ? `Asset ${index + 1}/${this.workspaceState.assets.length}: ${this.activeAssetId}`
      : `Active asset: ${this.activeAssetId}`;
  }

  updateUserFlowUi() {
    if (this.debugUiEnabled || !this.userFlowPanel) {
      return;
    }

    const assetCount = this.workspaceState.assets.length;
    const hasAssets = assetCount > 0;
    const activeAssetInfo = this.getActiveAssetOrdinalText();
    const waitingForConfirm =
      this.userFlowMode === 'generate' && this.userFlowAwaitingPromptConfirmation;

    for (let i = 0; i < this.userFlowButtons.length; i++) {
      this.configureUserFlowButton(i, {visible: false});
    }

    if (this.userFlowMode === 'generate') {
      this.userFlowModeText.text = 'Generate';
      this.userFlowDetailText.text = waitingForConfirm
        ? `Prompt: ${this.currentPrompt || '(empty)'}\nSay yes or no, or use the buttons below.`
        : `Generated assets: ${assetCount}\nPush to talk, then review the prompt before generating.`;

      this.configureUserFlowButton(0, {
        text: this.isRecordingPrompt
          ? 'Stop'
          : waitingForConfirm
            ? 'Say Yes/No'
            : 'Push To Talk',
        backgroundColor: '#9a3412',
        onTriggered: () => this.handleUserFlowRecordAction(),
      });
      this.configureUserFlowButton(1, {
        text: 'Confirm',
        backgroundColor: waitingForConfirm ? '#2563eb' : '#1f2937',
        onTriggered: () => this.confirmUserFlowGeneratePrompt(),
        visible: waitingForConfirm,
      });
      this.configureUserFlowButton(2, {
        text: 'Cancel',
        backgroundColor: '#6b7280',
        onTriggered: () => this.cancelUserFlowGeneratePrompt(),
        visible: waitingForConfirm,
      });
      this.configureUserFlowButton(3, {
        text: 'Next',
        backgroundColor: hasAssets ? '#0f766e' : '#1f2937',
        onTriggered: () => this.enterSegmentMode(),
      });
    } else if (this.userFlowMode === 'segment') {
      this.userFlowModeText.text = 'Segment';
      this.userFlowDetailText.text =
        `${activeAssetInfo}\nKept-only view stays on. Use the selection tool to mark what to keep or discard.`;

      this.configureUserFlowButton(0, {
        text: this.isSelectionMode ? 'Select: ON' : 'Select: OFF',
        backgroundColor: this.isSelectionMode ? '#0f766e' : '#374151',
        onTriggered: () => this.toggleSelectionMode(),
      });
      this.configureUserFlowButton(1, {
        text: this.selectionController?.getPaintMode?.() === 'keep' ? 'Mode: Keep' : 'Mode: Drop',
        backgroundColor: this.selectionController?.getPaintMode?.() === 'keep' ? '#166534' : '#991b1b',
        onTriggered: () => this.togglePaintMode(),
      });
      this.configureUserFlowButton(2, {
        text: 'Previous',
        backgroundColor: hasAssets ? '#334155' : '#1f2937',
        onTriggered: () => this.stepActiveAsset(-1),
      });
      this.configureUserFlowButton(3, {
        text: 'Next',
        backgroundColor: hasAssets ? '#334155' : '#1f2937',
        onTriggered: () => this.stepActiveAsset(1),
      });
      this.configureUserFlowButton(4, {
        text: 'Save Sel',
        backgroundColor: '#065f46',
        onTriggered: () => this.saveUserFlowWorkspaceSelection(),
      });
      this.configureUserFlowButton(5, {
        text: 'Load Sel',
        backgroundColor: '#1d4ed8',
        onTriggered: () => this.loadUserFlowWorkspaceSelection(),
      });
      this.configureUserFlowButton(7, {
        text: 'To Compose',
        backgroundColor: hasAssets ? '#7c3aed' : '#1f2937',
        onTriggered: () => this.enterComposeMode(),
      });
    } else if (this.userFlowMode === 'compose') {
      this.userFlowModeText.text = 'Compose';
      this.userFlowDetailText.text =
        `${activeAssetInfo}\nTransform one asset at a time with the gizmo, then compose the current workspace.`;

      this.configureUserFlowButton(0, {
        text: 'Previous',
        backgroundColor: hasAssets ? '#334155' : '#1f2937',
        onTriggered: () => this.stepActiveAsset(-1),
      });
      this.configureUserFlowButton(1, {
        text: 'Next',
        backgroundColor: hasAssets ? '#334155' : '#1f2937',
        onTriggered: () => this.stepActiveAsset(1),
      });
      this.configureUserFlowButton(6, {
        text: 'Compose',
        backgroundColor: hasAssets ? '#7c3aed' : '#1f2937',
        onTriggered: () => this.composeUserFlowWorkspace(),
      });
    }
  }

  createPromptKeyboard() {
    this.promptKeyboard = new Keyboard();
    this.add(this.promptKeyboard);
    this.promptKeyboard.visible = false;
    this.promptKeyboard.position.set(0, -0.42, 0.1);
    this.promptKeyboard.setText(this.currentPrompt);
    this.setPromptKeyboardInteractionEnabled(false);

    this.promptKeyboard.onTextChanged = (text) => {
      this.currentPrompt = text || '';
      this.workspaceState.prompt = this.currentPrompt;
      this.refreshPromptText();
      this.setStatus('Editing prompt manually...');
    };

    this.promptKeyboard.onEnterPressed = (text) => {
      this.currentPrompt = text || this.currentPrompt;
      this.workspaceState.prompt = this.currentPrompt;
      this.refreshPromptText();
      this.hidePromptEditor('Prompt updated from keyboard.');
    };
  }

  setPromptKeyboardInteractionEnabled(enabled) {
    if (!this.promptKeyboard) return;
    this.promptKeyboard.traverse((node) => {
      node.ignoreReticleRaycast = !enabled;
    });
  }

  createSelectionController() {
    this.selectionController = new MeshSelectionController({
      sceneRoot: this,
      onSelectionChanged: ({assetId, selections, selectedVertexCount}) => {
        this.handleSelectionChanged(assetId, selections, selectedVertexCount);
      },
      onStatus: (text) => this.setStatus(text),
    });
  }

  createTransformGizmoController() {
    this.transformGizmoController = new TransformGizmoController({
      sceneRoot: this,
      onTransformChanged: (model) => {
        const assetId = model?.userData?.assetId;
        if (!assetId) return;
        const assetRecord = this.getAssetRecord(assetId);
        if (!assetRecord) return;
        assetRecord.transformMatrix = this.getPersistedTransformMatrix(
          model,
          normalizeTransformMatrix(assetRecord)
        );
        this.refreshPromptText();
        this.updateTransformUi();
      },
      onStatus: (text) => this.setStatus(text),
    });
  }

  bindSpeechRecognizer() {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus(
        'Speech recognition unavailable. Use Edit Prompt or the default prompt.'
      );
      return;
    }

    recognizer.addEventListener('result', (event) => {
      const {transcript, isFinal} = event;
      if (this.recordingPurpose === 'confirmation') {
        this.confirmationTranscript = transcript || this.confirmationTranscript;
        if (isFinal) {
          this.isRecordingPrompt = false;
          this.updateRecordButton();
        }
        return;
      }

      this.currentPrompt = transcript || this.currentPrompt;
      this.workspaceState.prompt = this.currentPrompt;
      if (this.promptKeyboard) {
        this.promptKeyboard.setText(this.currentPrompt);
      }
      this.refreshPromptText();
      if (isFinal) {
        this.isRecordingPrompt = false;
        this.updateRecordButton();
        if (this.debugUiEnabled || this.userFlowMode !== 'generate') {
          this.setStatus('Prompt captured. You can generate now.');
        }
      }
    });

    recognizer.addEventListener('error', (event) => {
      this.isRecordingPrompt = false;
      this.recordingPurpose = 'prompt';
      this.updateRecordButton();
      this.updateMicDiagnostics('Speech error: ' + event.error);
      this.setStatus('Speech error: ' + event.error);
    });

    recognizer.addEventListener('end', async () => {
      const finishedPurpose = this.recordingPurpose;
      const confirmationTranscript = this.confirmationTranscript;
      this.isRecordingPrompt = false;
      this.recordingPurpose = 'prompt';
      this.updateRecordButton();

      if (this.debugUiEnabled || this.userFlowMode !== 'generate') {
        return;
      }

      if (finishedPurpose === 'prompt') {
        await this.handleUserFlowPromptRecordingEnded();
      } else if (finishedPurpose === 'confirmation') {
        this.handleUserFlowConfirmationTranscript(confirmationTranscript);
      }
    });
  }

  refreshPromptText() {
    if (!this.promptText) {
      return;
    }

    const prompt = this.currentPrompt || '(empty)';
    const assetCount = this.workspaceState.assets.length;
    const activeAsset = this.activeAssetId ? this.getAssetRecord(this.activeAssetId) : null;
    const activeSuffix = this.activeAssetId
      ? ` | Active asset: ${this.activeAssetId}`
      : '';
    const selectionSuffix = activeAsset?.selections?.length
      ? ` | Selection groups: ${activeAsset.selections.length}`
      : '';
    this.promptText.text =
      `Prompt: ${prompt}\nAssets: ${assetCount}${activeSuffix}${selectionSuffix}`;
    this.updateUserFlowUi();
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
    if (this.recordButton) {
      this.recordButton.text = this.isRecordingPrompt ? 'Stop' : 'Record';
    }
    this.updateUserFlowUi();
  }

  updateSelectionUi() {
    if (!this.selectionModeButton || !this.paintModeButton || !this.previewSelectionButton || !this.clearSelectionButton) {
      return;
    }

    const hasTarget = !!this.activeAssetId && !!this.assetInstances.get(this.activeAssetId);
    const paintMode = this.selectionController?.getPaintMode?.() || 'discard';
    const activeAssetRecord = this.activeAssetId
      ? this.getAssetRecord(this.activeAssetId)
      : null;
    const viewMode = activeAssetRecord?.viewMode || 'full';

    this.selectionModeButton.text = hasTarget
      ? this.isSelectionMode
        ? 'Select: ON'
        : 'Select: OFF'
      : 'Select: N/A';
    this.selectionModeButton.backgroundColor = hasTarget
      ? this.isSelectionMode
        ? '#0f766e'
        : '#374151'
      : '#1f2937';

    this.paintModeButton.text = paintMode === 'keep' ? 'Mode: Keep' : 'Mode: Drop';
    this.paintModeButton.backgroundColor = paintMode === 'keep' ? '#166534' : '#991b1b';

    this.previewSelectionButton.text = 'Preview';
    this.previewSelectionButton.backgroundColor = hasTarget ? '#166534' : '#1f2937';

    this.clearSelectionButton.backgroundColor = hasTarget ? '#4b5563' : '#1f2937';
    if (this.toggleKeptOnlyButton) {
      this.toggleKeptOnlyButton.text = viewMode === 'kept-only'
        ? 'View: Kept'
        : 'View: Full';
      this.toggleKeptOnlyButton.backgroundColor = hasTarget
        ? viewMode === 'kept-only'
          ? '#0369a1'
          : '#1d4ed8'
        : '#1f2937';
    }
    this.updateUserFlowUi();
  }

  updateTransformUi() {
    if (!this.transformAssetText) {
      return;
    }

    const assetCount = this.workspaceState.assets.length;
    const activeIndex = this.workspaceState.assets.findIndex(
      (asset) => asset.assetId === this.activeAssetId
    );
    const hasTarget = !!this.activeAssetId && !!this.assetInstances.get(this.activeAssetId);

    if (hasTarget && activeIndex >= 0) {
      this.transformAssetText.text = 'Active Asset ' + (activeIndex + 1) + '/' + assetCount + ': ' + this.activeAssetId;
    } else if (assetCount > 0) {
      this.transformAssetText.text = 'Loaded assets: ' + assetCount + '. Choose Prev/Next Asset to target one.';
    } else {
      this.transformAssetText.text = 'No active asset selected.';
    }

    const cycleEnabled = assetCount > 1;
    if (this.transformPrevAssetButton) {
      this.transformPrevAssetButton.backgroundColor = cycleEnabled ? '#334155' : '#1f2937';
    }
    if (this.transformNextAssetButton) {
      this.transformNextAssetButton.backgroundColor = cycleEnabled ? '#334155' : '#1f2937';
    }
    if (this.moveXNegativeButton) this.moveXNegativeButton.backgroundColor = hasTarget ? "#1d4ed8" : "#1f2937";
    if (this.moveXPositiveButton) this.moveXPositiveButton.backgroundColor = hasTarget ? "#1d4ed8" : "#1f2937";
    if (this.moveZNegativeButton) this.moveZNegativeButton.backgroundColor = hasTarget ? "#0f766e" : "#1f2937";
    if (this.moveZPositiveButton) this.moveZPositiveButton.backgroundColor = hasTarget ? "#0f766e" : "#1f2937";
    if (this.moveYPositiveButton) this.moveYPositiveButton.backgroundColor = hasTarget ? "#7c3aed" : "#1f2937";
    if (this.moveYNegativeButton) this.moveYNegativeButton.backgroundColor = hasTarget ? "#7c3aed" : "#1f2937";
    if (this.rotateNegativeButton) this.rotateNegativeButton.backgroundColor = hasTarget ? "#b45309" : "#1f2937";
    if (this.rotatePositiveButton) this.rotatePositiveButton.backgroundColor = hasTarget ? "#b45309" : "#1f2937";
    if (this.scaleDownButton) this.scaleDownButton.backgroundColor = hasTarget ? "#475569" : "#1f2937";
    if (this.scaleUpButton) this.scaleUpButton.backgroundColor = hasTarget ? "#475569" : "#1f2937";
    this.updateUserFlowUi();
  }

  getActiveTransformTarget() {
    if (!this.activeAssetId) {
      return null;
    }
    return this.assetInstances.get(this.activeAssetId) || null;
  }

  stepActiveAsset(delta) {
    const assetCount = this.workspaceState.assets.length;
    if (!assetCount) {
      this.setStatus('Load or generate an asset before switching the active target.');
      return;
    }

    const currentIndex = Math.max(
      0,
      this.workspaceState.assets.findIndex((asset) => asset.assetId === this.activeAssetId)
    );
    const nextIndex = (currentIndex + delta + assetCount) % assetCount;
    const nextAsset = this.workspaceState.assets[nextIndex];
    if (!nextAsset) {
      return;
    }

    this.setActiveAsset(nextAsset.assetId);
    this.setStatus('Active asset set to ' + nextAsset.assetId + '.');
  }

  updateActiveAssetTransformRecord() {
    const model = this.getActiveTransformTarget();
    const assetRecord = this.activeAssetId ? this.getAssetRecord(this.activeAssetId) : null;
    if (!model || !assetRecord) {
      return;
    }

    this.upsertAssetRecord({
      ...assetRecord,
      transformMatrix: this.getPersistedTransformMatrix(
        model,
        normalizeTransformMatrix(assetRecord)
      ),
    });
  }

  applyActiveAssetTransform(mutator, statusText) {
    const model = this.getActiveTransformTarget();
    if (!model || !this.activeAssetId) {
      this.setStatus('Select an active asset before applying transforms.');
      return;
    }

    mutator(model);
    model.updateMatrix();
    model.updateMatrixWorld(true);
    this.updateActiveAssetTransformRecord();
    this.setStatus(statusText.replace('{assetId}', this.activeAssetId));
  }

  translateActiveAsset(dx, dy, dz) {
    this.applyActiveAssetTransform((model) => {
      model.position.add(new THREE.Vector3(dx, dy, dz));
    }, 'Moved {assetId} by (' + dx.toFixed(2) + ', ' + dy.toFixed(2) + ', ' + dz.toFixed(2) + ').');
  }

  rotateActiveAsset(deltaRadians) {
    this.applyActiveAssetTransform((model) => {
      model.rotateOnWorldAxis(WORLD_UP, deltaRadians);
    }, 'Rotated {assetId} by ' + THREE.MathUtils.radToDeg(deltaRadians).toFixed(0) + ' degrees around world Y.');
  }

  scaleActiveAsset(multiplier) {
    this.applyActiveAssetTransform((model) => {
      const nextScale = Math.max(0.01, model.scale.x * multiplier);
      model.scale.setScalar(nextScale);
    }, 'Scaled {assetId} by ' + multiplier.toFixed(2) + 'x.');
  }

  setStatus(text) {
    if (this.statusText) {
      this.statusText.text = text;
    }
    if (this.userFlowStatusText) {
      this.userFlowStatusText.text = text;
    }
  }

  togglePromptEditor() {
    if (!this.promptKeyboard) return;
    if (this.isPromptEditorOpen) {
      this.hidePromptEditor('Prompt editor closed.');
      return;
    }

    this.isPromptEditorOpen = true;
    this.promptKeyboard.setText(this.currentPrompt || '');
    this.promptKeyboard.visible = true;
    this.setPromptKeyboardInteractionEnabled(true);
    this.setStatus('Prompt editor open. Type on the XR keyboard and press Enter.');
  }

  hidePromptEditor(statusText = 'Prompt editor closed.') {
    if (!this.promptKeyboard) return;
    this.isPromptEditorOpen = false;
    this.promptKeyboard.visible = false;
    this.setPromptKeyboardInteractionEnabled(false);
    this.setStatus(statusText);
  }

  restoreDefaultPrompt() {
    this.currentPrompt = DEFAULT_PROMPT;
    this.workspaceState.prompt = this.currentPrompt;
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
    }
    this.refreshPromptText();
    this.setStatus('Default prompt restored.');
  }

  removeLastPromptCharacter() {
    if (!this.currentPrompt) {
      this.setStatus('Prompt is already empty.');
      return;
    }

    this.currentPrompt = this.currentPrompt.slice(0, -1);
    this.workspaceState.prompt = this.currentPrompt;
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
    }
    this.refreshPromptText();
    this.setStatus('Removed the last prompt character.');
  }

  async captureScreenshot() {
    this.setStatus('Capturing screenshot...');
    try {
      let image = '';
      if (USE_DESKTOP_GEMINI_CAPTURE) {
        image = await loadImageAsDataUrl(DESKTOP_GEMINI_CAPTURE_URL);
      } else if (xb.core.deviceCamera?.loaded) {
        const snapshot = await xb.core.deviceCamera.getSnapshot({
          outputFormat: 'base64',
        });
        if (!snapshot) {
          throw new Error('Device camera snapshot returned no data.');
        }
        image = snapshot;
      } else {
        const useCameraOverlay = OVERLAY_ON_CAMERA && !!xb.core.deviceCamera;
        image = await xb.core.screenshotSynthesizer.getScreenshot(useCameraOverlay);
      }

      this.lastScreenshotDataUrl = image;
      this.workspaceState.lastScreenshotDataUrl = image;
      this.previewImage.load(image);
      if (this.userFlowPreviewImage) {
        this.userFlowPreviewImage.load(image);
      }
      this.showUserFlowCapturePreview();
      this.setStatus(
        USE_DESKTOP_GEMINI_CAPTURE
          ? 'Loaded test capture from assets/desktop_gemini.png.'
          : xb.core.deviceCamera?.loaded
            ? 'Device camera snapshot captured.'
            : OVERLAY_ON_CAMERA && !!xb.core.deviceCamera
              ? 'Camera-overlay screenshot captured.'
              : 'Scene screenshot captured.'
      );
    } catch (error) {
      console.error('Failed to capture screenshot.', error);
      this.setStatus('Screenshot capture failed.');
    }
  }

  togglePromptRecording(purpose = 'prompt') {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus('Speech recognition is unavailable in this browser.');
      this.updateMicDiagnostics('No recognizer instance is available.');
      return;
    }

    if (this.isRecordingPrompt) {
      recognizer.stop();
      this.isRecordingPrompt = false;
      this.setStatus(
        this.recordingPurpose === 'confirmation'
          ? 'Stopped listening for confirmation.'
          : 'Stopped listening for prompt.'
      );
    } else {
      this.recordingPurpose = purpose;
      this.confirmationTranscript = '';
      this.isRecordingPrompt = true;
      this.updateMicDiagnostics('Speech recognizer start requested.');
      this.setStatus(
        purpose === 'confirmation'
          ? 'Listening for yes or no...'
          : 'Listening for prompt...'
      );
      recognizer.start();
    }
    this.updateRecordButton();
  }

  handleUserFlowRecordAction() {
    if (this.userFlowMode !== 'generate') {
      this.togglePromptRecording();
      return;
    }

    this.togglePromptRecording(
      this.userFlowAwaitingPromptConfirmation ? 'confirmation' : 'prompt'
    );
  }

  showUserFlowCapturePreview() {
    if (this.debugUiEnabled || !this.userFlowPreviewPanel || !this.lastScreenshotDataUrl) {
      return;
    }

    this.userFlowPreviewPanel.visible = true;
    if (this.userCapturePreviewTimer) {
      clearTimeout(this.userCapturePreviewTimer);
    }
    this.userCapturePreviewTimer = setTimeout(() => {
      this.hideUserFlowCapturePreview();
    }, USER_CAPTURE_PREVIEW_MS);
  }

  hideUserFlowCapturePreview() {
    if (this.userCapturePreviewTimer) {
      clearTimeout(this.userCapturePreviewTimer);
      this.userCapturePreviewTimer = null;
    }
    if (this.userFlowPreviewPanel) {
      this.userFlowPreviewPanel.visible = false;
    }
  }

  async handleUserFlowPromptRecordingEnded() {
    if (this.debugUiEnabled || this.userFlowMode !== 'generate') {
      return;
    }
    if (!this.currentPrompt) {
      this.setStatus('No prompt was captured. Push to talk and try again.');
      return;
    }

    await this.captureScreenshot();
    this.userFlowAwaitingPromptConfirmation = true;
    this.updateUserFlowUi();
    this.setStatus('I heard "' + this.currentPrompt + '". Say yes or no, or use Confirm / Cancel.');
  }

  handleUserFlowConfirmationTranscript(transcript = '') {
    const normalized = (transcript || '').trim().toLowerCase();
    if (!normalized) {
      this.setStatus('Confirmation was not understood. Use Confirm / Cancel or say yes / no.');
      return;
    }

    if (/\b(yes|yeah|yep|sure|confirm|go ahead|do it)\b/.test(normalized)) {
      this.confirmUserFlowGeneratePrompt();
      return;
    }

    if (/\b(no|nope|cancel|not sure|retry|again)\b/.test(normalized)) {
      this.cancelUserFlowGeneratePrompt();
      return;
    }

    this.setStatus('Confirmation was unclear. Use Confirm / Cancel or say yes / no.');
  }

  async confirmUserFlowGeneratePrompt() {
    if (!this.userFlowAwaitingPromptConfirmation) {
      this.setStatus('Push to talk first to capture a prompt.');
      return;
    }

    this.userFlowAwaitingPromptConfirmation = false;
    this.updateUserFlowUi();
    await this.generateAsset();
  }

  cancelUserFlowGeneratePrompt() {
    this.userFlowAwaitingPromptConfirmation = false;
    this.confirmationTranscript = '';
    this.updateUserFlowUi();
    this.setStatus('Prompt cancelled. Push to talk for a new try.');
  }

  shouldEnableTransformTools() {
    return this.debugUiEnabled || this.userFlowMode === 'compose';
  }

  shouldEnableTransientModelViewerTransforms() {
    return !this.debugUiEnabled && (
      this.userFlowMode === 'generate' || this.userFlowMode === 'segment'
    );
  }

  restorePersistentAssetTransforms() {
    for (const assetRecord of this.workspaceState.assets) {
      const model = this.assetInstances.get(assetRecord.assetId);
      const transformMatrix = normalizeTransformMatrix(assetRecord);
      if (!model || !transformMatrix) {
        continue;
      }
      this.applyPersistedTransformToModel(model, transformMatrix);
    }
    this.syncTransformGizmo();
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

  setActiveAsset(assetId) {
    this.activeAssetId = assetId;
    this.syncSelectionController();
    this.syncTransformGizmo();
    this.refreshPromptText();
    this.updateTransformUi();
  }

  getAssetRecord(assetId) {
    return this.workspaceState.assets.find((asset) => asset.assetId === assetId) || null;
  }

  upsertAssetRecord(assetRecord) {
    const index = this.workspaceState.assets.findIndex(
      (asset) => asset.assetId === assetRecord.assetId
    );
    if (index >= 0) {
      this.workspaceState.assets[index] = assetRecord;
    } else {
      this.workspaceState.assets.push(assetRecord);
    }
    this.refreshPromptText();
    this.updateSelectionUi();
    this.updateTransformUi();
    this.syncTransformGizmo();
  }

  removeAssetInstance(assetId) {
    this.disposeDerivedAssetView(assetId);

    const trackedModel = this.assetInstances.get(assetId);
    if (trackedModel) {
      trackedModel.parent?.remove(trackedModel);
      trackedModel.dispose?.();
      this.assetInstances.delete(assetId);
    }

    const orphanedModels = this.children.filter(
      (child) => child?.userData?.assetId === assetId
    );
    for (const model of orphanedModels) {
      model.parent?.remove(model);
      model.dispose?.();
    }

    if (this.activeAssetId === assetId) {
      this.activeAssetId = null;
    }

    this.updateTransformUi();
    this.syncTransformGizmo();
  }

  clearAssetInstances() {
    for (const assetId of [...this.assetInstances.keys()]) {
      this.removeAssetInstance(assetId);
    }
    this.syncSelectionController();
    this.syncTransformGizmo();
  }

  getDefaultPlacementForIndex(index) {
    return {
      x: ((index % 3) - 1) * 0.32,
      y: 0.78,
      z: -1.1 - Math.floor(index / 3) * 0.16,
    };
  }

  createAssetRecordFromResponse(asset, existingRecord = null) {
    return {
      assetId: asset.assetId,
      latentHandle: asset.latentHandle,
      glbUrl: asset.glbUrl,
      prompt: asset.metadata?.prompt || this.currentPrompt,
      thumbnailUrl: asset.thumbnailUrl || this.lastScreenshotDataUrl,
      transformMatrix: normalizeTransformMatrix(existingRecord) || null,
      selections: existingRecord?.selections || [],
      viewMode: existingRecord?.viewMode || 'full',
    };
  }

  markModelViewerHelperNodes(model) {
    if (!model) return;
    for (const helper of [model.rotationRaycastMesh, model.platform, model.controlBar]) {
      if (!helper) continue;
      helper.traverse((node) => {
        node.userData.isModelViewerHelper = true;
      });
    }
    if (model.rotationRaycastMesh) {
      model.rotationRaycastMesh.visible = false;
    }
  }

  findModelContentRoot(model) {
    if (!model) return null;
    return model.gltfMesh?.scene ||
      model.children.find((child) => child.type === 'Group' || child.type === 'Scene') ||
      model;
  }

  assignSelectionNodePaths(model) {
    const contentRoot = this.findModelContentRoot(model);
    if (!contentRoot) return;

    const counters = new Map();
    contentRoot.traverse((node) => {
      if (!node.isMesh || !node.geometry?.attributes?.position) return;
      node.userData.selectionNodePath = this.createSelectionNodePath(node, counters, contentRoot);
    });
  }

  createSelectionNodePath(node, counters, contentRoot) {
    const pathParts = [];
    let current = node;
    while (current && current !== contentRoot) {
      const baseName = current.name?.trim() || current.type || 'node';
      const key = `${current.parent?.uuid || 'root'}:${baseName}`;
      const seen = counters.get(key) || 0;
      counters.set(key, seen + 1);
      pathParts.push(`${baseName}_${seen}`);
      current = current.parent;
    }
    return `/${pathParts.reverse().join('/')}`;
  }

  toggleActiveAssetViewMode() {
    if (!this.activeAssetId) {
      this.setStatus('Load or generate an asset before changing the view mode.');
      return;
    }

    const assetRecord = this.getAssetRecord(this.activeAssetId);
    if (!assetRecord) {
      this.setStatus('Active asset record is missing.');
      return;
    }

    const nextMode = assetRecord.viewMode === 'kept-only' ? 'full' : 'kept-only';
    this.setAssetViewMode(this.activeAssetId, nextMode);
    this.setStatus(
      nextMode === 'kept-only'
        ? `Kept-only preview enabled for ${this.activeAssetId}.`
        : `Full mesh view restored for ${this.activeAssetId}.`
    );
  }

  setAssetViewMode(assetId, viewMode) {
    const assetRecord = this.getAssetRecord(assetId);
    if (!assetRecord) return;

    const normalizedMode = viewMode === 'kept-only' ? 'kept-only' : 'full';
    this.upsertAssetRecord({
      ...assetRecord,
      viewMode: normalizedMode,
    });

    if (normalizedMode === 'kept-only') {
      this.rebuildKeptOnlyView(assetId);
    }
    this.applyAssetViewMode(assetId);
  }

  applyAssetViewMode(assetId) {
    const model = this.assetInstances.get(assetId);
    const assetRecord = this.getAssetRecord(assetId);
    if (!model || !assetRecord) return;

    const showKeptOnly = assetRecord.viewMode === 'kept-only' && (assetRecord.selections?.length || 0) > 0;
    model.traverse((node) => {
      if (!node.isMesh) return;
      if (node.userData?.isDerivedKeptOnly) return;
      if (node.userData?.isModelViewerHelper) return;
      node.visible = !showKeptOnly;
    });

    const derivedGroup = this.assetDerivedViews.get(assetId);
    if (derivedGroup) {
      derivedGroup.visible = showKeptOnly;
    }

    this.updateSelectionUi();
  }

  disposeDerivedAssetView(assetId) {
    const derivedGroup = this.assetDerivedViews.get(assetId);
    if (!derivedGroup) return;

    derivedGroup.traverse((node) => {
      if (node.userData?.ownsDerivedGeometry) {
        node.geometry?.dispose?.();
      }
      if (node.userData?.ownsDerivedMaterial) {
        if (Array.isArray(node.material)) {
          node.material.forEach((material) => material?.dispose?.());
        } else {
          node.material?.dispose?.();
        }
      }
    });
    derivedGroup.parent?.remove(derivedGroup);
    this.assetDerivedViews.delete(assetId);
  }

  rebuildKeptOnlyView(assetId) {
    const model = this.assetInstances.get(assetId);
    const assetRecord = this.getAssetRecord(assetId);
    if (!model || !assetRecord) return;

    this.disposeDerivedAssetView(assetId);
    if (!assetRecord.selections?.length) {
      return;
    }

    const selectionsByNodePath = new Map();
    for (const selection of assetRecord.selections || []) {
      selectionsByNodePath.set(selection.nodePath, new Set(selection.vertexIndices || []));
    }

    const derivedGroup = new THREE.Group();
    derivedGroup.name = `${assetId}-kept-only-view`;
    const modelInverseWorld = new THREE.Matrix4().copy(model.matrixWorld).invert();

    model.traverse((node) => {
      if (!node.isMesh || !node.geometry?.attributes?.position) return;
      const keepSet = selectionsByNodePath.get(node.userData?.selectionNodePath);
      if (!keepSet || keepSet.size === 0) return;

      const derivedGeometry = this.createKeptOnlyGeometry(node.geometry, keepSet);
      if (!derivedGeometry) return;

      const derivedMaterial = this.cloneDerivedMaterial(node.material);
      const derivedMesh = new THREE.Mesh(derivedGeometry, derivedMaterial);
      derivedMesh.userData.isDerivedKeptOnly = true;
      derivedMesh.userData.ownsDerivedGeometry = true;
      derivedMesh.userData.ownsDerivedMaterial = true;
      derivedMesh.matrixAutoUpdate = false;
      derivedMesh.matrix.copy(modelInverseWorld).multiply(node.matrixWorld);
      derivedMesh.matrix.decompose(derivedMesh.position, derivedMesh.quaternion, derivedMesh.scale);
      derivedMesh.updateMatrix();
      derivedGroup.add(derivedMesh);
    });

    if (derivedGroup.children.length === 0) {
      return;
    }

    model.add(derivedGroup);
    this.assetDerivedViews.set(assetId, derivedGroup);
  }

  cloneDerivedMaterial(material) {
    if (Array.isArray(material)) {
      return material.map((entry) => this.cloneDerivedMaterial(entry));
    }

    const clone = material?.clone?.() || new THREE.MeshStandardMaterial();
    clone.side = THREE.DoubleSide;
    return clone;
  }

  createKeptOnlyGeometry(geometry, keepSet) {
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) return null;

    if (geometry.index) {
      const sourceIndex = geometry.index.array;
      const keptIndices = [];
      for (let i = 0; i < sourceIndex.length; i += 3) {
        const a = sourceIndex[i];
        const b = sourceIndex[i + 1];
        const c = sourceIndex[i + 2];
        if (keepSet.has(a) && keepSet.has(b) && keepSet.has(c)) {
          keptIndices.push(a, b, c);
        }
      }

      if (!keptIndices.length) {
        return null;
      }

      const derivedGeometry = geometry.clone();
      derivedGeometry.setIndex(keptIndices);
      derivedGeometry.computeVertexNormals();
      derivedGeometry.computeBoundingBox();
      derivedGeometry.computeBoundingSphere();
      return derivedGeometry;
    }

    const keptVertexTriples = [];
    const stride = positionAttr.itemSize || 3;
    const source = positionAttr.array;
    for (let i = 0; i < positionAttr.count; i += 3) {
      const a = i;
      const b = i + 1;
      const c = i + 2;
      if (!keepSet.has(a) || !keepSet.has(b) || !keepSet.has(c)) {
        continue;
      }

      for (const vertexIndex of [a, b, c]) {
        const base = vertexIndex * stride;
        keptVertexTriples.push(source[base], source[base + 1], source[base + 2]);
      }
    }

    if (!keptVertexTriples.length) {
      return null;
    }

    const derivedGeometry = new THREE.BufferGeometry();
    derivedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(keptVertexTriples, 3));
    derivedGeometry.computeVertexNormals();
    derivedGeometry.computeBoundingBox();
    derivedGeometry.computeBoundingSphere();
    return derivedGeometry;
  }

  buildWorkspaceSnapshot({useLiveTransforms = true} = {}) {
    const assets = this.workspaceState.assets.map((assetRecord) => {
      const model = this.assetInstances.get(assetRecord.assetId);
      return {
        assetId: assetRecord.assetId,
        latentHandle: assetRecord.latentHandle,
        glbUrl: assetRecord.glbUrl,
        prompt: assetRecord.prompt,
        thumbnailUrl: assetRecord.thumbnailUrl,
        transformMatrix: useLiveTransforms && model
          ? this.getPersistedTransformMatrix(model, normalizeTransformMatrix(assetRecord))
          : normalizeTransformMatrix(assetRecord),
        selections: assetRecord.selections || [],
        viewMode: assetRecord.viewMode || 'full',
      };
    });

    return {
      sessionId: this.workspaceState.sessionId,
      prompt: this.currentPrompt,
      lastScreenshotDataUrl: this.lastScreenshotDataUrl,
      assets,
    };
  }

  handleSelectionChanged(assetId, selections, selectedVertexCount) {
    if (!assetId) {
      return;
    }
    const assetRecord = this.getAssetRecord(assetId);
    if (!assetRecord) {
      return;
    }

    this.upsertAssetRecord({
      ...assetRecord,
      selections,
    });

    if ((assetRecord.viewMode || 'full') === 'kept-only') {
      this.rebuildKeptOnlyView(assetId);
      this.applyAssetViewMode(assetId);
    }

    if (selectedVertexCount === 0) {
      this.setStatus(`Selection reset for ${assetId}. Whole asset is implicitly kept again.`);
    }
  }

  syncSelectionController() {
    if (!this.selectionController) {
      return;
    }

    const activeAssetId = this.activeAssetId;
    const activeModel = activeAssetId ? this.assetInstances.get(activeAssetId) : null;
    const activeAssetRecord = activeAssetId ? this.getAssetRecord(activeAssetId) : null;

    if (activeAssetId && activeModel && activeAssetRecord) {
      this.selectionController.attach({
        assetId: activeAssetId,
        model: activeModel,
        selections: activeAssetRecord.selections || [],
      });
      this.selectionController.setDrawMode(this.isSelectionMode);
    } else {
      this.selectionController.detach();
    }

    this.applyWorkspaceInteractionPolicy();
    this.updateSelectionUi();
  }

  syncTransformGizmo() {
    if (!this.transformGizmoController) {
      return;
    }

    const activeModel = this.activeAssetId ? this.assetInstances.get(this.activeAssetId) : null;
    this.transformGizmoController.setTarget(activeModel || null, {
      enabled: !!activeModel && !this.isSelectionMode && this.shouldEnableTransformTools(),
    });
  }

  applyWorkspaceInteractionPolicy() {
    const allowTransientModelViewerTransforms =
      this.shouldEnableTransientModelViewerTransforms() && !this.isSelectionMode;
    const activeModel = this.activeAssetId
      ? this.assetInstances.get(this.activeAssetId)
      : null;

    for (const model of this.assetInstances.values()) {
      const enableModelViewerInteraction =
        allowTransientModelViewerTransforms && model === activeModel;
      model.draggable = enableModelViewerInteraction;
      model.rotatable = enableModelViewerInteraction;
      model.scalable = enableModelViewerInteraction;
      model.traverse((node) => {
        const hiddenFromView = node.visible === false;
        const isDerivedKeptOnly = !!node.userData?.isDerivedKeptOnly;
        const isExplicitDragHandle = !!node.draggingMode;
        node.ignoreReticleRaycast =
          !enableModelViewerInteraction ||
          (hiddenFromView && !isExplicitDragHandle) ||
          isDerivedKeptOnly;
      });
    }

    this.transformGizmoController?.setEnabled(
      !!this.activeAssetId && !this.isSelectionMode && this.shouldEnableTransformTools()
    );
  }

  togglePaintMode() {
    if (!this.selectionController) {
      return;
    }
    const nextMode = this.selectionController.getPaintMode() === 'keep'
      ? 'discard'
      : 'keep';
    this.selectionController.setPaintMode(nextMode);
    this.updateSelectionUi();
    this.setStatus(
      nextMode === 'keep'
        ? 'Paint mode set to keep. Green sculpt strokes will preserve geometry.'
        : 'Paint mode set to discard. Red sculpt strokes will remove geometry from the keep set.'
    );
  }
  toggleSelectionMode() {
    if (!this.activeAssetId || !this.assetInstances.get(this.activeAssetId)) {
      this.setStatus('Load or generate an asset before entering selection mode.');
      return;
    }

    const activeAssetRecord = this.getAssetRecord(this.activeAssetId);
    if (
      !this.isSelectionMode &&
      activeAssetRecord?.viewMode === 'kept-only' &&
      this.userFlowMode !== 'segment'
    ) {
      this.setAssetViewMode(this.activeAssetId, 'full');
    }

    this.isSelectionMode = !this.isSelectionMode;
    this.selectionController.setDrawMode(this.isSelectionMode);
    this.applyWorkspaceInteractionPolicy();
    this.updateSelectionUi();
    this.setStatus(
      this.isSelectionMode
        ? `Selection mode enabled for ${this.activeAssetId}. Pinch-drag to ${this.selectionController.getPaintMode() === 'keep' ? 'keep' : 'discard'} geometry with the sculpt brush.`
        : 'Selection mode disabled. Object manipulation restored.'
    );
  }

  previewSelection() {
    if (!this.selectionController?.hasTarget()) {
      this.setStatus('No active asset is ready for selection preview.');
      return;
    }

    const count = this.selectionController.renderSelectionPreview();
    this.updateSelectionUi();
    if (count === 0) {
      this.setStatus('No kept vertices to preview yet.');
      return;
    }
    this.setStatus(`Previewing ${count} kept vertices in green.`);
  }

  clearSelection() {
    if (!this.selectionController?.hasTarget()) {
      this.setStatus('No active asset is ready for selection editing.');
      return;
    }

    this.selectionController.clearSelection();
    this.updateSelectionUi();
    this.setStatus(`Selection reset for ${this.activeAssetId}. Whole asset is implicitly kept again.`);
  }

  async saveUserFlowWorkspaceOverwrite({createIfNeeded = false} = {}) {
    if (!this.userFlowWorkspaceId) {
      if (!createIfNeeded) {
        this.setStatus('No session workspace exists yet. Finish generate mode first.');
        return null;
      }
      this.userFlowWorkspaceId = this.generateWorkspaceSnapshotId();
    }

    const workspace = this.buildWorkspaceSnapshot({useLiveTransforms: false});
    this.apiClient.workspaceId = this.userFlowWorkspaceId;
    this.refreshWorkspaceStatusText();
    return await this.apiClient.saveWorkspace(workspace);
  }

  async saveUserFlowWorkspaceSelection() {
    const saved = await this.saveUserFlowWorkspaceOverwrite({createIfNeeded: true});
    if (!saved) {
      return;
    }
    this.setStatus('Selection workspace saved.');
  }

  async loadUserFlowWorkspaceSelection() {
    if (!this.userFlowWorkspaceId) {
      this.setStatus('No saved workspace exists for this session yet.');
      return;
    }

    this.apiClient.workspaceId = this.userFlowWorkspaceId;
    this.refreshWorkspaceStatusText();
    await this.loadWorkspace();
    this.userFlowMode = 'segment';
    this.applySegmentModeDefaults();
    this.setStatus('Latest saved selections restored for this session.');
  }

  applySegmentModeDefaults() {
    if (!this.workspaceState.assets.length) {
      this.isSelectionMode = false;
      this.selectionController?.setDrawMode(false);
      this.updateSelectionUi();
      return;
    }

    for (const asset of this.workspaceState.assets) {
      this.setAssetViewMode(asset.assetId, 'kept-only');
    }
    this.setActiveAsset(this.workspaceState.assets[0].assetId);
    this.isSelectionMode = true;
    this.selectionController?.setDrawMode(true);
    this.applyWorkspaceInteractionPolicy();
    this.updateSelectionUi();
  }

  async enterSegmentMode() {
    if (!this.workspaceState.assets.length) {
      this.setStatus('Generate at least one asset before continuing to segment mode.');
      return;
    }

    await this.saveUserFlowWorkspaceOverwrite({createIfNeeded: true});
    this.userFlowAwaitingPromptConfirmation = false;
    this.userFlowMode = 'segment';
    this.hideUserFlowCapturePreview();
    this.applySegmentModeDefaults();
    this.updateUserFlowUi();
    this.setStatus('Segment mode started. Choose what to keep on each asset.');
  }

  applyComposeModeDefaults({preserveActive = false} = {}) {
    this.isSelectionMode = false;
    this.selectionController?.setDrawMode(false);
    if (this.workspaceState.assets.length) {
      const nextActiveAssetId = preserveActive && this.activeAssetId
        ? this.activeAssetId
        : this.workspaceState.assets[0].assetId;
      this.setActiveAsset(nextActiveAssetId);
    }
    this.applyWorkspaceInteractionPolicy();
    this.updateSelectionUi();
  }

  async enterComposeMode() {
    if (!this.workspaceState.assets.length) {
      this.setStatus('No assets are available for compose mode.');
      return;
    }

    this.restorePersistentAssetTransforms();
    await this.saveUserFlowWorkspaceOverwrite({createIfNeeded: true});
    this.userFlowMode = 'compose';
    this.applyComposeModeDefaults();
    this.updateUserFlowUi();
    this.setStatus('Compose mode started. Transform one asset at a time, then compose the workspace.');
  }

  async composeUserFlowWorkspace() {
    if (!this.workspaceState.assets.length) {
      this.setStatus('No assets are available to compose.');
      return;
    }

    if (this.currentJobId) {
      this.setStatus('Another backend job is already running.');
      return;
    }

    this.restorePersistentAssetTransforms();
    await this.saveUserFlowWorkspaceOverwrite({createIfNeeded: true});
    const workspaceId = this.userFlowWorkspaceId;

    try {
      const job = await this.apiClient.createComposeJob({
        sessionId: this.sessionId,
        workspaceId,
        compose: {
          normalizeToDecoderGrid: false,
        },
      });

      this.currentJobId = job.jobId;
      this.setStatus('Compose job queued for ' + workspaceId + ': ' + job.jobId);
      this.startPollingJob(job.jobId, {
        jobLabel: 'Compose',
        onCompleted: async (update) => {
          await this.loadGeneratedAsset(update.asset, 'Composed');
          this.userFlowMode = 'compose';
          this.applyComposeModeDefaults({preserveActive: true});
          this.refreshAssetCatalog().catch((error) => {
            console.warn('Failed to refresh asset catalog after compose.', error);
          });
        },
        failedMessage: 'Compose failed.',
      });
    } catch (error) {
      console.error('Failed to start compose job.', error);
      this.setStatus('Compose request failed.');
    }
  }
  refreshCatalogUi() {
    if (!this.catalogText) {
      return;
    }

    if (!this.catalogItems.length) {
      this.catalogText.text = 'Catalog: no assets loaded yet. Press Refresh to fetch backend assets.';
      return;
    }

    const index = Math.max(0, Math.min(this.catalogIndex, this.catalogItems.length - 1));
    const item = this.catalogItems[index];
    const prompt = item?.metadata?.prompt || item?.assetId || 'Unnamed asset';
    const source = item?.sourceType || 'asset';
    this.catalogText.text = `Catalog ${index + 1}/${this.catalogItems.length}: ${item.assetId}\n${prompt}\nSource: ${source}`;
  }

  refreshWorkspaceStatusText() {
    if (!this.workspaceStatusText) {
      return;
    }
    this.workspaceStatusText.text = `Current WS: ${this.apiClient.workspaceId}`;
  }

  refreshWorkspaceCatalogUi() {
    if (!this.workspaceCatalogText) {
      return;
    }

    if (!this.workspaceCatalogItems.length) {
      this.workspaceCatalogText.text = 'Workspace catalog: no saved workspaces found. Press Refresh WS.';
      this.refreshWorkspaceStatusText();
      return;
    }

    const index = Math.max(
      0,
      Math.min(this.workspaceCatalogIndex, this.workspaceCatalogItems.length - 1)
    );
    const item = this.workspaceCatalogItems[index];
    const prompt = item?.prompt || item?.workspaceId || 'Unnamed workspace';
    const assetCount = item?.assetCount ?? item?.workspace?.assets?.length ?? 0;
    const savedAt = item?.savedAt
      ? new Date(item.savedAt).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'unknown time';
    this.workspaceCatalogText.text = `WS ${index + 1}/${this.workspaceCatalogItems.length}: ${item.workspaceId}\n${prompt}\nAssets: ${assetCount} | Saved: ${savedAt}`;
    this.refreshWorkspaceStatusText();
  }

  async fetchAssetCatalogItems() {
    if (this.apiClient.useBackend) {
      const response = await fetch(`${this.apiClient.backendUrl}/assets`);
      if (!response.ok) {
        throw new Error(`Asset listing failed: ${response.status}`);
      }
      const payload = await response.json();
      return payload.items || [];
    }

    const raw = localStorage.getItem('xrblocks.sam3d_workspace.phase1');
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    const assets = parsed?.workspace?.assets || [];
    return assets.map((asset, index) => ({
      assetId: asset.assetId,
      latentHandle: asset.latentHandle || asset.assetId,
      glbUrl: asset.glbUrl,
      thumbnailUrl: asset.thumbnailUrl || null,
      savedAt: parsed.savedAt || Date.now(),
      sourceType: 'workspace-local',
      hasLatents: true,
      metadata: {
        prompt: asset.prompt || parsed?.workspace?.prompt || `Local asset ${index + 1}`,
        workspaceId: parsed.workspaceId || this.apiClient.workspaceId,
        jobId: null,
      },
    }));
  }

  async refreshAssetCatalog() {
    this.setStatus('Refreshing asset catalog...');
    try {
      this.catalogItems = await this.fetchAssetCatalogItems();
      this.catalogIndex = 0;
      this.refreshCatalogUi();
      this.setStatus(
        this.catalogItems.length
          ? `Loaded ${this.catalogItems.length} asset(s) into the catalog.`
          : 'Asset catalog is empty.'
      );
    } catch (error) {
      console.error('Failed to refresh asset catalog.', error);
      this.catalogItems = [];
      this.catalogIndex = 0;
      this.refreshCatalogUi();
      this.setStatus('Asset catalog refresh failed.');
    }
  }

  async fetchWorkspaceCatalogItems() {
    if (this.apiClient.useBackend) {
      const response = await fetch(`${this.apiClient.backendUrl}/workspaces`);
      if (!response.ok) {
        throw new Error(`Workspace listing failed: ${response.status}`);
      }
      const payload = await response.json();
      return payload.items || payload.workspaces || payload.workspaceIds || [];
    }

    const raw = localStorage.getItem('xrblocks.sam3d_workspace.phase1');
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return [{
      workspaceId: parsed.workspaceId || this.apiClient.workspaceId,
      savedAt: parsed.savedAt || Date.now(),
      prompt: parsed?.workspace?.prompt || this.currentPrompt,
      assetCount: parsed?.workspace?.assets?.length || 0,
    }];
  }

  async refreshWorkspaceCatalog() {
    this.setStatus('Refreshing workspace catalog...');
    try {
      this.workspaceCatalogItems = await this.fetchWorkspaceCatalogItems();
      this.workspaceCatalogIndex = 0;
      this.refreshWorkspaceCatalogUi();
      this.setStatus(
        this.workspaceCatalogItems.length
          ? `Loaded ${this.workspaceCatalogItems.length} workspace(s) into the catalog.`
          : 'Workspace catalog is empty.'
      );
    } catch (error) {
      console.error('Failed to refresh workspace catalog.', error);
      this.workspaceCatalogItems = [];
      this.workspaceCatalogIndex = 0;
      this.refreshWorkspaceCatalogUi();
      this.setStatus('Workspace catalog refresh failed.');
    }
  }

  stepCatalog(direction) {
    if (!this.catalogItems.length) {
      this.setStatus('No catalog items available yet.');
      return;
    }
    const count = this.catalogItems.length;
    this.catalogIndex = (this.catalogIndex + direction + count) % count;
    this.refreshCatalogUi();
  }

  async loadCatalogAsset() {
    if (!this.catalogItems.length) {
      this.setStatus('No catalog asset is available to load.');
      return;
    }

    const selected = this.catalogItems[this.catalogIndex];
    const existingRecord = this.getAssetRecord(selected.assetId);
    const assetRecord = {
      assetId: selected.assetId,
      latentHandle: selected.latentHandle || selected.assetId,
      glbUrl: selected.glbUrl,
      prompt: selected.metadata?.prompt || selected.assetId,
      thumbnailUrl: selected.thumbnailUrl || '',
      transformMatrix: normalizeTransformMatrix(existingRecord) || null,
      selections: existingRecord?.selections || [],
      viewMode: existingRecord?.viewMode || 'full',
    };

    await this.instantiateAssetRecord(assetRecord);
    this.currentPrompt = assetRecord.prompt || this.currentPrompt;
    this.workspaceState.prompt = this.currentPrompt;
    this.refreshPromptText();
    this.setStatus(`Loaded catalog asset ${assetRecord.assetId} into the workspace.`);
  }

  async deleteSelectedCatalogAsset() {
    if (!this.catalogItems.length) {
      this.setStatus('No catalog asset is available to delete.');
      return;
    }

    const selected = this.catalogItems[this.catalogIndex];
    if (!selected?.assetId) {
      this.setStatus('Selected asset entry is missing an assetId.');
      return;
    }

    if (!this.apiClient.useBackend) {
      this.setStatus('Asset delete is only available when using the backend catalog.');
      return;
    }

    try {
      const response = await fetch(`${this.apiClient.backendUrl}/assets/${selected.assetId}`, {method: 'DELETE'});
      if (response.status === 409) {
        this.setStatus(`Cannot delete asset ${selected.assetId} because it is still referenced by a saved workspace.`);
        return;
      }
      if (!response.ok) {
        throw new Error(`Asset delete failed: ${response.status}`);
      }

      if (this.getAssetRecord(selected.assetId)) {
        this.removeAssetInstance(selected.assetId);
        this.workspaceState.assets = this.workspaceState.assets.filter(
          (asset) => asset.assetId !== selected.assetId
        );
        this.syncSelectionController();
        this.refreshPromptText();
      }

      await this.refreshAssetCatalog();
      this.setStatus(`Deleted asset ${selected.assetId} from the backend catalog.`);
    } catch (error) {
      console.error('Failed to delete asset.', error);
      this.setStatus('Asset delete failed.');
    }
  }

  stepWorkspaceCatalog(direction) {
    if (!this.workspaceCatalogItems.length) {
      this.setStatus('No workspace catalog items available yet.');
      return;
    }
    const count = this.workspaceCatalogItems.length;
    this.workspaceCatalogIndex =
      (this.workspaceCatalogIndex + direction + count) % count;
    this.refreshWorkspaceCatalogUi();
  }

  async loadSelectedWorkspaceCatalogItem() {
    if (!this.workspaceCatalogItems.length) {
      this.setStatus('No workspace catalog item is available to load.');
      return;
    }

    const selected = this.workspaceCatalogItems[this.workspaceCatalogIndex];
    if (!selected?.workspaceId) {
      this.setStatus('Selected workspace entry is missing a workspaceId.');
      return;
    }

    this.apiClient.workspaceId = selected.workspaceId;
    this.refreshWorkspaceStatusText();
    await this.loadWorkspace();
    this.refreshWorkspaceCatalogUi();
  }

  async composeSelectedWorkspaceCatalogItem() {
    if (!this.workspaceCatalogItems.length) {
      this.setStatus('No workspace catalog item is available to compose.');
      return;
    }

    if (this.currentJobId) {
      this.setStatus('Another backend job is already running.');
      return;
    }

    const selected = this.workspaceCatalogItems[this.workspaceCatalogIndex];
    if (!selected?.workspaceId) {
      this.setStatus('Selected workspace entry is missing a workspaceId.');
      return;
    }

    try {
      const workspaceId = selected.workspaceId;
      const job = await this.apiClient.createComposeJob({
        sessionId: this.sessionId,
        workspaceId,
        compose: {
          normalizeToDecoderGrid: false,
        },
      });

      this.currentJobId = job.jobId;
      this.setStatus(`Compose job queued for ${workspaceId}: ${job.jobId}`);
      this.startPollingJob(job.jobId, {
        jobLabel: 'Compose',
        onCompleted: async (update) => {
          await this.loadGeneratedAsset(update.asset, 'Composed');
          this.refreshAssetCatalog().catch((error) => {
            console.warn('Failed to refresh asset catalog after compose.', error);
          });
        },
        failedMessage: 'Compose failed.',
      });
    } catch (error) {
      console.error('Failed to start compose job.', error);
      this.setStatus('Compose request failed.');
    }
  }

  async deleteSelectedWorkspaceCatalogItem() {
    if (!this.workspaceCatalogItems.length) {
      this.setStatus('No workspace catalog item is available to delete.');
      return;
    }

    const selected = this.workspaceCatalogItems[this.workspaceCatalogIndex];
    if (!selected?.workspaceId) {
      this.setStatus('Selected workspace entry is missing a workspaceId.');
      return;
    }

    try {
      if (this.apiClient.useBackend) {
        const response = await fetch(`${this.apiClient.backendUrl}/workspaces/${selected.workspaceId}`, {method: 'DELETE'});
        if (!response.ok) {
          throw new Error(`Workspace delete failed: ${response.status}`);
        }
      } else {
        const raw = localStorage.getItem('xrblocks.sam3d_workspace.phase1');
        if (raw) {
          const parsed = JSON.parse(raw);
          if ((parsed.workspaceId || this.apiClient.workspaceId) === selected.workspaceId) {
            localStorage.removeItem('xrblocks.sam3d_workspace.phase1');
          }
        }
      }

      if (this.apiClient.workspaceId === selected.workspaceId) {
        this.apiClient.workspaceId = 'workspace-local';
        this.refreshWorkspaceStatusText();
      }

      await this.refreshWorkspaceCatalog();
      this.setStatus(`Deleted workspace ${selected.workspaceId}.`);
    } catch (error) {
      console.error('Failed to delete workspace.', error);
      this.setStatus('Workspace delete failed.');
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
      this.setStatus('Another backend job is already running.');
      return;
    }

    const job = await this.apiClient.createGenerationJob({
      sessionId: this.sessionId,
      prompt: this.currentPrompt,
      image: this.lastScreenshotDataUrl,
    });

    this.currentJobId = job.jobId;
    this.setStatus(`Generation job queued: ${job.jobId}`);
    this.startPollingJob(job.jobId, {
      jobLabel: 'Generation',
      onCompleted: async (update) => {
        await this.loadGeneratedAsset(update.asset, 'Generated');
      },
      failedMessage: 'Generation failed.',
    });
  }

  startPollingJob(jobId, {jobLabel = 'Job', onCompleted, failedMessage = 'Job failed.'} = {}) {
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }

    const pollGeneration = ++this.pollGeneration;

    const pollOnce = async () => {
      if (pollGeneration !== this.pollGeneration) {
        return;
      }

      try {
        const update = await this.apiClient.getJob(jobId);
        if (pollGeneration !== this.pollGeneration) {
          return;
        }

        if (update.status === 'running' || update.status === 'queued') {
          const progress = update.progress
            ? `${Math.round(update.progress * 100)}%`
            : 'starting';
          this.setStatus(
            `${jobLabel} ${update.status}: ${progress}${
              update.message ? ` - ${update.message}` : ''
            }`
          );
          this.pollHandle = setTimeout(pollOnce, POLL_INTERVAL_MS);
          return;
        }

        this.pollHandle = null;
        this.currentJobId = null;

        if (update.status === 'failed') {
          this.setStatus(update.error || failedMessage);
          return;
        }

        this.pollGeneration++;
        await onCompleted?.(update);
      } catch (error) {
        if (pollGeneration !== this.pollGeneration) {
          return;
        }
        this.pollHandle = null;
        this.currentJobId = null;
        console.error(`${jobLabel} polling failed.`, error);
        this.setStatus(`${jobLabel} polling failed.`);
      }
    };

    this.pollHandle = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }

  async instantiateAssetRecord(assetRecord, {setActive = true} = {}) {
    this.setStatus(`Loading asset ${assetRecord.assetId}...`);

    this.removeAssetInstance(assetRecord.assetId);

    const model = new xb.ModelViewer({});
    model.userData.assetId = assetRecord.assetId;
    this.add(model);

    const {path, model: modelName} = this.splitAssetUrl(assetRecord.glbUrl);
    await model.loadGLTFModel({
      data: {
        path,
        model: modelName,
        scale: {x: 1.0, y: 1.0, z: 1.0},
        verticallyAlignObject: false,
        horizontallyAlignObject: false,
      },
      setupRaycastCylinder: true,
      setupRaycastBox: false,
      setupPlatform: true,
      renderer: xb.core.renderer,
    });
    this.markModelViewerHelperNodes(model);

    const transformMatrix = normalizeTransformMatrix(assetRecord);
    if (transformMatrix) {
      this.applyPersistedTransformToModel(model, transformMatrix);
    } else {
      const placement = this.getDefaultPlacementForIndex(this.workspaceState.assets.length);
      model.position.set(placement.x, placement.y, placement.z);
      model.updateMatrix();
      model.updateMatrixWorld(true);
      assetRecord.transformMatrix = this.getPersistedTransformMatrix(
        model,
        matrixToArray(model)
      );
    }

    this.assignSelectionNodePaths(model);

    this.assetInstances.set(assetRecord.assetId, model);
    this.upsertAssetRecord({
      ...assetRecord,
      transformMatrix:
        normalizeTransformMatrix(assetRecord) ||
        this.getPersistedTransformMatrix(model, matrixToArray(model)),
      selections: assetRecord.selections || [],
      viewMode: assetRecord.viewMode || 'full',
    });

    if ((assetRecord.viewMode || 'full') === 'kept-only') {
      this.rebuildKeptOnlyView(assetRecord.assetId);
    }

    if (setActive) {
      this.setActiveAsset(assetRecord.assetId);
      this.applyAssetViewMode(assetRecord.assetId);
    } else {
      this.applyAssetViewMode(assetRecord.assetId);
      this.applyWorkspaceInteractionPolicy();
      this.updateSelectionUi();
    }

    return model;
  }

  async loadGeneratedAsset(asset, sourceLabel = 'Generated') {
    const existingRecord = this.getAssetRecord(asset.assetId);
    const assetRecord = this.createAssetRecordFromResponse(asset, existingRecord);
    const model = await this.instantiateAssetRecord(assetRecord);
    assetRecord.transformMatrix = this.getPersistedTransformMatrix(
      model,
      matrixToArray(model)
    );
    this.upsertAssetRecord(assetRecord);
    this.currentPrompt = assetRecord.prompt || this.currentPrompt;
    this.workspaceState.prompt = this.currentPrompt;
    this.refreshPromptText();
    this.setStatus(
      `${sourceLabel} asset loaded. Active asset: ${assetRecord.assetId}. Workspace assets: ${this.workspaceState.assets.length}.`
    );
  }

  getPersistedTransformMatrix(model, fallbackMatrix = null) {
    if (!model) {
      return fallbackMatrix;
    }

    model.updateMatrixWorld(true);
    return model.matrixWorld.toArray();
  }

  applyPersistedTransformToModel(model, transformArray) {
    if (!model || !transformArray) return;
    this.applyTransformToModel(model, transformArray);
    model.updateMatrixWorld(true);
  }

  splitAssetUrl(url) {
    const lastSlash = url.lastIndexOf('/') + 1;
    return {
      path: url.slice(0, lastSlash),
      model: url.slice(lastSlash),
    };
  }

  generateWorkspaceSnapshotId() {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    return `workspace-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  }

  async saveWorkspace() {
    const workspace = this.buildWorkspaceSnapshot();
    this.apiClient.workspaceId = this.generateWorkspaceSnapshotId();
    this.refreshWorkspaceStatusText();
    const saved = await this.apiClient.saveWorkspace(workspace);
    this.refreshWorkspaceCatalog().catch((error) => {
      console.warn('Failed to refresh workspace catalog after save.', error);
    });
    const destination = this.apiClient.getStorageLabel();
    const savedWorkspaceId = this.apiClient.workspaceId;
    const savedAt = saved?.savedAt
      ? new Date(saved.savedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'just now';

    if (workspace.assets.length === 0) {
      this.setStatus(`Workspace saved to ${destination} with no assets yet (${savedAt}).`);
      return;
    }
    this.setStatus(
      `Workspace snapshot ${savedWorkspaceId} saved to ${destination} at ${savedAt} with ${workspace.assets.length} asset(s).`
    );
  }

  async loadWorkspace() {
    const saved = await this.apiClient.loadWorkspace();
    if (!saved?.workspace) {
      this.setStatus(`No saved workspace found in ${this.apiClient.getStorageLabel()}.`);
      return;
    }

    this.clearAssetInstances();
    this.workspaceState = {
      sessionId: saved.workspace.sessionId || this.sessionId,
      prompt: saved.workspace.prompt || this.currentPrompt,
      lastScreenshotDataUrl: saved.workspace.lastScreenshotDataUrl || '',
      assets: [],
    };
    this.activeAssetId = null;

    this.currentPrompt = this.workspaceState.prompt;
    this.refreshPromptText();
    this.refreshWorkspaceStatusText();
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
    }

    this.lastScreenshotDataUrl = this.workspaceState.lastScreenshotDataUrl;
    this.previewImage.load(this.lastScreenshotDataUrl || '');
    if (this.userFlowPreviewImage) {
      this.userFlowPreviewImage.load(this.lastScreenshotDataUrl || '');
    }

    const savedAssets = saved.workspace.assets || [];
    for (const savedAsset of savedAssets) {
      const normalizedRecord = {
        assetId: savedAsset.assetId,
        latentHandle: savedAsset.latentHandle,
        glbUrl: savedAsset.glbUrl,
        prompt: savedAsset.prompt,
        thumbnailUrl: savedAsset.thumbnailUrl,
        transformMatrix: normalizeTransformMatrix(savedAsset),
        selections: savedAsset.selections || [],
        viewMode: savedAsset.viewMode || 'full',
      };
      await this.instantiateAssetRecord(normalizedRecord, {setActive: false});
    }

    if (savedAssets.length > 0) {
      this.setActiveAsset(savedAssets[savedAssets.length - 1].assetId);
      this.setStatus(
        `Workspace restored from ${this.apiClient.getStorageLabel()} with ${savedAssets.length} asset(s).`
      );
      return;
    }

    this.syncSelectionController();
    this.setStatus(
      `Workspace restored from ${this.apiClient.getStorageLabel()} with no assets.`
    );
  }

  applyTransformToModel(model, transformArray) {
    if (!model || !transformArray) return;
    const matrix = new THREE.Matrix4().fromArray(transformArray);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    model.position.copy(position);
    model.quaternion.copy(quaternion);
    model.scale.copy(scale);
    model.updateMatrix();
    model.updateMatrixWorld(true);
  }

  resetWorkspace() {
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    this.currentJobId = null;
    this.pollGeneration++;
    this.clearAssetInstances();
    this.activeAssetId = null;
    this.isSelectionMode = false;
    this.selectionController?.detach();
    this.lastScreenshotDataUrl = '';
    this.previewImage.load('');
    this.hideUserFlowCapturePreview();
    this.userFlowAwaitingPromptConfirmation = false;
    this.recordingPurpose = 'prompt';
    this.confirmationTranscript = '';
    this.userFlowWorkspaceId = null;
    if (!this.debugUiEnabled) {
      this.userFlowMode = 'generate';
    }
    this.workspaceState = this.createEmptyWorkspaceState();
    this.workspaceState.assets = [];
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
      this.hidePromptEditor('Workspace reset.');
    }
    this.updateMicDiagnostics();
    this.updateSelectionUi();
    this.refreshPromptText();
    this.setStatus('Workspace reset.');
  }

  onSelectStart(event) {
    if (this.transformGizmoController?.onSelectStart(event)) {
      return;
    }
    this.selectionController?.onSelectStart(event);
  }

  onSelecting(event) {
    if (this.transformGizmoController?.onSelecting(event)) {
      return;
    }
    this.selectionController?.onSelecting(event);
  }

  onSelectEnd(event) {
    if (this.transformGizmoController?.onSelectEnd(event)) {
      return;
    }
    this.selectionController?.onSelectEnd(event);
  }

  update() {
    this.transformGizmoController?.update();
    this.selectionController?.update();
  }

  dispose() {
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    this.pollGeneration++;
    this.hideUserFlowCapturePreview();
    this.transformGizmoController?.dispose();
    this.transformGizmoController = null;
    this.selectionController?.dispose();
    this.selectionController = null;
    this.clearAssetInstances();
    if (xb.core?.scene && xb.core.scene.environment === this.environmentTexture) {
      xb.core.scene.environment = this.previousEnvironment;
    }
    this.environmentTarget?.dispose?.();
    this.environmentTarget = null;
    this.environmentTexture = null;
    this.previousEnvironment = null;
    super.dispose();
  }
}



