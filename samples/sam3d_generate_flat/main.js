import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const POLL_INTERVAL_MS = 1200;
const DEFAULT_BACKEND_URL = 'http://localhost:8790';

const params = new URL(window.location.href).searchParams;
const sessionId = params.get('sessionId') || `flat-${crypto.randomUUID()}`;
const workspaceId = params.get('workspaceId') || `flat-workspace-${crypto.randomUUID()}`;
const artifactHint = params.get('artifactHint') || '';

const form = document.querySelector('#generate-form');
const backendUrlInput = document.querySelector('#backend-url');
const promptInput = document.querySelector('#prompt');
const imageFileInput = document.querySelector('#image-file');
const fileName = document.querySelector('#file-name');
const imagePreview = document.querySelector('#image-preview');
const imagePlaceholder = document.querySelector('#image-placeholder');
const generateButton = document.querySelector('#generate-button');
const statusLabel = document.querySelector('#status-label');
const progressLabel = document.querySelector('#progress-label');
const progress = document.querySelector('#progress');
const statusMessage = document.querySelector('#status-message');
const downloadLink = document.querySelector('#download-link');
const viewer = document.querySelector('#viewer');
const viewerPlaceholder = document.querySelector('#viewer-placeholder');

let imageDataUrl = '';
let currentAssetUrl = '';
let loadedModel = null;
let pollTimer = null;

backendUrlInput.value = (params.get('backendUrl') || DEFAULT_BACKEND_URL).replace(/\/$/, '');
promptInput.value = params.get('prompt') || '';

const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
viewer.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b5f4a, 2.2));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(4, 5, 3);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffead0, 0.8);
fillLight.position.set(-3, 2, -4);
scene.add(fillLight);

const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(1.8, 1.2, 2.8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.5, 0);

const loader = new GLTFLoader();

function setStatus(label, message, value = null) {
  statusLabel.textContent = label;
  statusMessage.textContent = message;
  if (typeof value === 'number') {
    progress.value = THREE.MathUtils.clamp(value, 0, 1);
    progressLabel.textContent = `${Math.round(progress.value * 100)}%`;
  }
}

function setBusy(isBusy) {
  generateButton.disabled = isBusy;
  generateButton.textContent = isBusy ? 'Generating...' : 'Generate model';
}

function getBackendUrl() {
  return backendUrlInput.value.trim().replace(/\/$/, '');
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:') || !dataUrl.includes(',')) {
    return {
      mimeType: 'application/octet-stream',
      dataUrl: dataUrl || '',
    };
  }

  const [header] = dataUrl.split(',', 1);
  return {
    mimeType: header.split(';', 1)[0].replace('data:', ''),
    dataUrl,
  };
}

function resolveUrl(url, baseUrl = getBackendUrl()) {
  if (!url) return '';
  try {
    return new URL(url, baseUrl ? `${baseUrl}/` : window.location.href).toString();
  } catch (_) {
    return url;
  }
}

async function createGenerationJob({backendUrl, prompt, image}) {
  const response = await fetch(`${backendUrl}/generate`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      sessionId,
      workspaceId,
      prompt,
      image: parseDataUrl(image),
      artifactHint: artifactHint || undefined,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return payload;
}

async function getJob(backendUrl, jobId) {
  const response = await fetch(`${backendUrl}/jobs/${encodeURIComponent(jobId)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return payload;
}

function getJobProgress(job) {
  if (typeof job.progress === 'number') return job.progress;
  if (typeof job.percent === 'number') return job.percent / 100;
  return job.status === 'completed' ? 1 : 0;
}

function getStatusMessage(job) {
  const parts = [];
  if (job.message) parts.push(job.message);
  if (job.status === 'queued') {
    if (Number.isFinite(job.queuePosition)) parts.push(`position ${job.queuePosition}`);
    if (Number.isFinite(job.queueAhead)) parts.push(`${job.queueAhead} ahead`);
    if (job.runningJobId) parts.push(`waiting for ${job.runningJobId}`);
  }
  return parts.join(' | ') || `Job ${job.status || 'pending'}`;
}

function extractAsset(job) {
  return job.asset || job.result?.asset || job.data?.asset || null;
}

function updateDownloadLink(assetUrl) {
  currentAssetUrl = assetUrl || '';
  if (!currentAssetUrl) {
    downloadLink.classList.add('disabled');
    downloadLink.removeAttribute('href');
    return;
  }

  downloadLink.href = currentAssetUrl;
  downloadLink.download = currentAssetUrl.split('/').pop()?.split('?')[0] || 'sam3d-model.glb';
  downloadLink.classList.remove('disabled');
}

function clearModel() {
  if (!loadedModel) return;
  scene.remove(loadedModel);
  loadedModel.traverse((node) => {
    if (node.isMesh) {
      node.geometry?.dispose?.();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        material?.dispose?.();
      }
    }
  });
  loadedModel = null;
}

function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  object.position.sub(center);
  const maxSize = Math.max(size.x, size.y, size.z, 0.001);
  const distance = maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  camera.position.set(distance * 0.7, distance * 0.45, distance * 1.35);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

async function loadModel(assetUrl) {
  const resolvedUrl = resolveUrl(assetUrl);
  clearModel();
  viewerPlaceholder.style.display = 'none';
  setStatus('Loading model', 'Downloading generated model...', 1);

  return new Promise((resolve, reject) => {
    loader.load(
      resolvedUrl,
      (gltf) => {
        loadedModel = gltf.scene;
        scene.add(loadedModel);
        fitCameraToObject(loadedModel);
        updateDownloadLink(resolvedUrl);
        setStatus('Completed', 'Generated model loaded. You can orbit the preview or download the asset.', 1);
        resolve();
      },
      undefined,
      (error) => {
        viewerPlaceholder.style.display = '';
        reject(error);
      }
    );
  });
}

function schedulePoll(backendUrl, jobId) {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }

  const poll = async () => {
    try {
      const job = await getJob(backendUrl, jobId);
      const value = getJobProgress(job);
      setStatus(job.status || 'Polling', getStatusMessage(job), value);

      if (job.status === 'completed') {
        const asset = extractAsset(job);
        const assetUrl = asset?.glbUrl || asset?.url || asset?.modelUrl;
        if (!assetUrl) {
          throw new Error('Completed job did not include asset.glbUrl.');
        }
        await loadModel(assetUrl);
        setBusy(false);
        return;
      }

      if (job.status === 'failed' || job.status === 'error') {
        throw new Error(job.error || job.message || 'Generation failed.');
      }

      pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    } catch (error) {
      setBusy(false);
      setStatus('Error', error instanceof Error ? error.message : 'Job polling failed.', 0);
    }
  };

  pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
}

function resizeRenderer() {
  const rect = viewer.getBoundingClientRect();
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  resizeRenderer();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

imageFileInput.addEventListener('change', () => {
  const file = imageFileInput.files?.[0];
  if (!file) {
    imageDataUrl = '';
    imagePreview.style.display = 'none';
    imagePlaceholder.style.display = '';
    fileName.textContent = 'PNG or JPG reference image';
    return;
  }

  fileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = String(reader.result || '');
    imagePreview.src = imageDataUrl;
    imagePreview.style.display = 'block';
    imagePlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const backendUrl = getBackendUrl();
  const prompt = promptInput.value.trim();
  if (!backendUrl) {
    setStatus('Missing backend', 'Enter a backend URL, for example http://localhost:8790.', 0);
    return;
  }
  if (!prompt) {
    setStatus('Missing prompt', 'Enter a prompt before generating.', 0);
    return;
  }
  if (!imageDataUrl) {
    setStatus('Missing image', 'Choose an image file before generating.', 0);
    return;
  }

  try {
    setBusy(true);
    updateDownloadLink('');
    setStatus('Submitting', 'Sending generation request...', 0.02);
    const job = await createGenerationJob({backendUrl, prompt, image: imageDataUrl});
    if (!job.jobId) {
      throw new Error('Backend did not return a jobId.');
    }
    setStatus(job.status || 'Queued', `Generation job queued: ${job.jobId}`, 0.05);
    schedulePoll(backendUrl, job.jobId);
  } catch (error) {
    setBusy(false);
    setStatus('Error', error instanceof Error ? error.message : 'Generation request failed.', 0);
  }
});

downloadLink.addEventListener('click', async (event) => {
  if (!currentAssetUrl) return;
  event.preventDefault();
  try {
    const response = await fetch(currentAssetUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = downloadLink.download || 'sam3d-model.glb';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
  } catch (_) {
    window.open(currentAssetUrl, '_blank', 'noopener,noreferrer');
  }
});

window.addEventListener('resize', resizeRenderer);
resizeRenderer();
animate();
