import * as THREE from 'three';
import {TubePainter} from 'three/addons/misc/TubePainter.js';

const DEFAULT_PROXIMITY = 0.03;
const DEFAULT_BRUSH_RADIUS = 0.01;
const DEFAULT_POINTER_SIZE = 0.012;
const DEFAULT_STAMP_INTERVAL_MS = 70;
const DEFAULT_SAMPLE_STEP_DISTANCE = 0.015;
const MAX_STROKE_PAINTERS = 64;

export class MeshSelectionController {
  constructor({
    sceneRoot,
    onSelectionChanged = () => {},
    onStatus = () => {},
  }) {
    this.sceneRoot = sceneRoot;
    this.onSelectionChanged = onSelectionChanged;
    this.onStatus = onStatus;

    this.overlay = new THREE.Group();
    this.sceneRoot.add(this.overlay);

    this.raycaster = new THREE.Raycaster();
    this.brushRadius = DEFAULT_BRUSH_RADIUS;
    this.pointerSize = DEFAULT_POINTER_SIZE;
    this.proximity = DEFAULT_PROXIMITY;
    this.stampIntervalMs = DEFAULT_STAMP_INTERVAL_MS;
    this.sampleStepDistance = DEFAULT_SAMPLE_STEP_DISTANCE;

    this.activeAssetId = null;
    this.activeModel = null;
    this.contentRoot = null;
    this.meshes = [];
    this.meshMetaByNodePath = new Map();
    this.meshByNodePath = new Map();
    this.isDrawMode = false;
    this.isPinching = false;
    this.activePinchSource = null;
    this.selectedVertexCount = 0;
    this.strokePainters = [];
    this.currentStrokePainter = null;
    this.lastStrokePoint = null;
    this.lastStampTimeMs = 0;
    this.previewVisible = false;

    this._tmpRotation = new THREE.Matrix4();
    this._tmpScale = new THREE.Vector3();
    this._tmpWorldPoint = new THREE.Vector3();
    this._tmpLocalPoint = new THREE.Vector3();
    this._tmpRayDirection = new THREE.Vector3();
    this._tmpRayOrigin = new THREE.Vector3();
    this._tmpStrokePoint = new THREE.Vector3();
    this._tmpInterpPoint = new THREE.Vector3();
  }

  dispose() {
    this.detach();
    this.sceneRoot?.remove(this.overlay);
  }

  attach({assetId, model, selections = []}) {
    this.detach();

    this.activeAssetId = assetId;
    this.activeModel = model;
    this.contentRoot = this.findContentRoot(model);
    this.buildMeshIndex();
    this.applySelections(selections);
    this.applyModelInteractionPolicy();
  }

  detach() {
    this.setDrawMode(false);
    this.clearSelectionPreview();
    this.clearDrawMarkers();
    this.applyModelInteractionPolicy(true);

    this.activeAssetId = null;
    this.activeModel = null;
    this.contentRoot = null;
    this.meshes = [];
    this.meshMetaByNodePath.clear();
    this.meshByNodePath.clear();
    this.selectedVertexCount = 0;
    this.previewVisible = false;
    this.isPinching = false;
    this.activePinchSource = null;
  }

  findContentRoot(model) {
    if (!model) return null;
    return (
      model.children.find((child) => child.type === 'Group' || child.type === 'Scene') ||
      model
    );
  }

  buildMeshIndex() {
    this.meshes = [];
    this.meshMetaByNodePath.clear();
    this.meshByNodePath.clear();
    this.selectedVertexCount = 0;

    if (!this.contentRoot) return;

    const counters = new Map();
    this.contentRoot.traverse((node) => {
      if (!node.isMesh || !node.geometry?.attributes?.position) return;
      const positionAttr = node.geometry.attributes.position;
      const vertexCount = positionAttr.count;
      if (vertexCount <= 0) return;

      const nodePath = this.createNodePath(node, counters);
      const selectionMask = new Array(vertexCount).fill(false);
      const meta = {
        mesh: node,
        nodePath,
        positionAttr,
        vertexCount,
        selectionMask,
        selectedCount: 0,
      };

      this.meshes.push(node);
      this.meshMetaByNodePath.set(nodePath, meta);
      this.meshByNodePath.set(nodePath, node);
      node.userData.selectionNodePath = nodePath;
    });
  }

  createNodePath(node, counters) {
    const pathParts = [];
    let current = node;
    while (current && current !== this.contentRoot) {
      const baseName = current.name?.trim() || current.type || 'node';
      const key = `${current.parent?.uuid || 'root'}:${baseName}`;
      const seen = counters.get(key) || 0;
      counters.set(key, seen + 1);
      pathParts.push(`${baseName}_${seen}`);
      current = current.parent;
    }
    return `/${pathParts.reverse().join('/')}`;
  }

  setDrawMode(enabled) {
    this.isDrawMode = enabled && !!this.activeModel && this.meshes.length > 0;
    if (!this.isDrawMode) {
      this.isPinching = false;
      this.activePinchSource = null;
      this.endStroke();
    }
    this.applyModelInteractionPolicy();
  }

  getDrawMode() {
    return this.isDrawMode;
  }

  hasTarget() {
    return !!this.activeModel && this.meshes.length > 0;
  }

  getSelectionCount() {
    return this.selectedVertexCount;
  }

  clearSelection() {
    for (const meta of this.meshMetaByNodePath.values()) {
      meta.selectionMask.fill(false);
      meta.selectedCount = 0;
    }
    this.selectedVertexCount = 0;
    this.clearSelectionPreview();
    this.clearDrawMarkers();
    this.previewVisible = false;
    this.emitSelectionChanged();
  }

  applySelections(selections = []) {
    for (const meta of this.meshMetaByNodePath.values()) {
      meta.selectionMask.fill(false);
      meta.selectedCount = 0;
    }

    for (const selection of selections) {
      const meta = this.meshMetaByNodePath.get(selection.nodePath);
      if (!meta) continue;
      for (const index of selection.vertexIndices || []) {
        if (index < 0 || index >= meta.vertexCount) continue;
        if (!meta.selectionMask[index]) {
          meta.selectionMask[index] = true;
          meta.selectedCount += 1;
        }
      }
    }

    this.selectedVertexCount = [...this.meshMetaByNodePath.values()].reduce(
      (sum, meta) => sum + meta.selectedCount,
      0
    );

    if (this.previewVisible) {
      this.renderSelectionPreview();
    }
    this.emitSelectionChanged();
  }

  exportSelections() {
    const selections = [];
    for (const meta of this.meshMetaByNodePath.values()) {
      if (!meta.selectedCount) continue;
      const vertexIndices = [];
      for (let i = 0; i < meta.selectionMask.length; i++) {
        if (meta.selectionMask[i]) {
          vertexIndices.push(i);
        }
      }
      selections.push({
        nodePath: meta.nodePath,
        vertexIndices,
        proximity: this.proximity,
      });
    }
    return selections;
  }

  emitSelectionChanged() {
    this.onSelectionChanged({
      assetId: this.activeAssetId,
      selections: this.exportSelections(),
      selectedVertexCount: this.selectedVertexCount,
    });
  }

  applyModelInteractionPolicy(forceEnable = false) {
    if (!this.activeModel) return;
    const allowModelInteraction = forceEnable || !this.isDrawMode;
    this.activeModel.draggable = allowModelInteraction;
    this.activeModel.rotatable = allowModelInteraction;
    this.activeModel.scalable = allowModelInteraction;

    this.activeModel.traverse((node) => {
      if (node === this.overlay || node.userData?.isSelectionPreview) return;
      node.ignoreReticleRaycast = !allowModelInteraction;
    });
  }

  clearDrawMarkers() {
    this.currentStrokePainter = null;
    this.lastStrokePoint = null;
    for (const painter of this.strokePainters) {
      const mesh = painter.mesh;
      this.overlay.remove(mesh);
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    }
    this.strokePainters.length = 0;
  }

  clearSelectionPreview() {
    for (const mesh of this.meshes) {
      const children = [...mesh.children];
      for (const child of children) {
        if (!child.userData?.isSelectionPreview) continue;
        mesh.remove(child);
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      }
    }
  }

  renderSelectionPreview() {
    this.clearSelectionPreview();

    let totalPreviewed = 0;
    for (const meta of this.meshMetaByNodePath.values()) {
      if (!meta.selectedCount) continue;
      const selectedLocal = [];
      const pos = meta.positionAttr.array;
      const stride = meta.positionAttr.itemSize || 3;
      for (let i = 0; i < meta.vertexCount; i++) {
        if (!meta.selectionMask[i]) continue;
        const base = i * stride;
        selectedLocal.push(pos[base], pos[base + 1], pos[base + 2]);
      }
      if (!selectedLocal.length) continue;

      const previewGeom = new THREE.BufferGeometry();
      previewGeom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(selectedLocal, 3)
      );
      const previewMat = new THREE.PointsMaterial({
        color: 0xff4d4d,
        size: 0.01,
        sizeAttenuation: true,
        depthWrite: false,
      });
      const previewPoints = new THREE.Points(previewGeom, previewMat);
      previewPoints.userData.isSelectionPreview = true;
      meta.mesh.add(previewPoints);
      totalPreviewed += selectedLocal.length / 3;
    }

    this.previewVisible = totalPreviewed > 0;
    return totalPreviewed;
  }

  beginStroke(worldPoint) {
    const painter = new TubePainter();
    painter.setSize(this.pointerSize);
    painter.mesh.material.color.set(0xff4d4d);
    painter.moveTo(worldPoint);
    painter.lineTo(worldPoint);
    painter.update();
    this.overlay.add(painter.mesh);
    this.strokePainters.push(painter);
    this.currentStrokePainter = painter;
    this.lastStrokePoint = worldPoint.clone();

    if (this.strokePainters.length > MAX_STROKE_PAINTERS) {
      const old = this.strokePainters.shift();
      this.overlay.remove(old.mesh);
      old.mesh.geometry?.dispose?.();
      old.mesh.material?.dispose?.();
    }
  }

  appendStrokePoint(worldPoint) {
    if (!this.currentStrokePainter) {
      this.beginStroke(worldPoint);
      return;
    }
    if (!this.lastStrokePoint) {
      this.lastStrokePoint = worldPoint.clone();
    }
    const distance = this.lastStrokePoint.distanceTo(worldPoint);
    if (distance < 0.002) return;

    const steps = Math.max(1, Math.ceil(distance / this.sampleStepDistance));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._tmpStrokePoint.copy(this.lastStrokePoint).lerp(worldPoint, t);
      this.currentStrokePainter.lineTo(this._tmpStrokePoint);
    }
    this.currentStrokePainter.update();
    this.lastStrokePoint.copy(worldPoint);
  }

  endStroke() {
    this.currentStrokePainter = null;
    this.lastStrokePoint = null;
  }

  paintVerticesFromHit(worldPoint, mesh) {
    const nodePath = mesh?.userData?.selectionNodePath;
    if (!nodePath) return 0;
    const meta = this.meshMetaByNodePath.get(nodePath);
    if (!meta) return 0;

    mesh.getWorldScale(this._tmpScale);
    const avgScale =
      (this._tmpScale.x + this._tmpScale.y + this._tmpScale.z) / 3;
    const localRadius = this.brushRadius / Math.max(avgScale, 1e-6);
    const radiusSq = localRadius * localRadius;
    this._tmpLocalPoint.copy(worldPoint);
    mesh.worldToLocal(this._tmpLocalPoint);

    const pos = meta.positionAttr.array;
    const stride = meta.positionAttr.itemSize || 3;
    let changed = 0;
    for (let i = 0; i < meta.vertexCount; i++) {
      const base = i * stride;
      const dx = pos[base] - this._tmpLocalPoint.x;
      const dy = pos[base + 1] - this._tmpLocalPoint.y;
      const dz = pos[base + 2] - this._tmpLocalPoint.z;
      if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
      if (!meta.selectionMask[i]) {
        meta.selectionMask[i] = true;
        meta.selectedCount += 1;
        changed += 1;
      }
    }

    if (changed > 0) {
      this.selectedVertexCount += changed;
      this.emitSelectionChanged();
    }
    return changed;
  }
  sampleDrawFromSource(source, force = false) {
    if (!source || !this.isDrawMode || !this.meshes.length) return;
    const now = performance.now();
    if (!force && now - this.lastStampTimeMs < this.stampIntervalMs) return;

    source.getWorldPosition(this._tmpRayOrigin);
    this._tmpRotation.identity().extractRotation(source.matrixWorld);
    this._tmpRayDirection.set(0, 0, -1).applyMatrix4(this._tmpRotation).normalize();
    this.raycaster.ray.origin.copy(this._tmpRayOrigin);
    this.raycaster.ray.direction.copy(this._tmpRayDirection);

    const intersections = this.raycaster.intersectObjects(this.meshes, false);
    if (!intersections.length) return;

    const hit = intersections[0];
    this._tmpWorldPoint.copy(hit.point);
    if (this.lastStrokePoint) {
      const distance = this.lastStrokePoint.distanceTo(this._tmpWorldPoint);
      const steps = Math.max(1, Math.ceil(distance / this.sampleStepDistance));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this._tmpInterpPoint
          .copy(this.lastStrokePoint)
          .lerp(this._tmpWorldPoint, t);
        this.paintVerticesFromHit(this._tmpInterpPoint, hit.object);
      }
    } else {
      this.paintVerticesFromHit(this._tmpWorldPoint, hit.object);
    }

    this.appendStrokePoint(this._tmpWorldPoint);
    this.onStatus(
      `Selecting vertices: ${this.selectedVertexCount} kept on ${this.activeAssetId || 'asset'}.`
    );
    this.lastStampTimeMs = now;
  }

  onSelectStart(event) {
    if (!this.isDrawMode) return;
    this.isPinching = true;
    this.activePinchSource = event.target;
    this.endStroke();
    this.sampleDrawFromSource(event.target, true);
  }

  onSelecting(event) {
    if (!this.isDrawMode || !this.isPinching) return;
    const source = event.target || this.activePinchSource;
    this.activePinchSource = source;
    this.sampleDrawFromSource(source);
  }

  onSelectEnd(event) {
    if (!this.isDrawMode) return;
    if (!this.activePinchSource || event.target === this.activePinchSource) {
      this.isPinching = false;
      this.activePinchSource = null;
      this.endStroke();
    }
  }

  update() {
    if (!this.isDrawMode || !this.isPinching || !this.activePinchSource) return;
    this.sampleDrawFromSource(this.activePinchSource);
  }
}
