"""Mock backend for the SAM3D workspace sample.

This server provides a minimal HTTP API for local XR iteration:

- POST /generate
- GET /jobs/<job_id>
- POST /workspaces/<workspace_id>/save
- GET /workspaces/<workspace_id>
- GET /healthz

It intentionally avoids third-party dependencies so it can run with the Python
standard library only.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


DEFAULT_PORT = 8790
DEFAULT_MODEL_URL = (
    'https://cdn.jsdelivr.net/gh/xrblocks/assets@main/models/Cat/cat.gltf'
)


def _safe_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def _strip_data_url_prefix(data_url: str) -> tuple[str, str]:
    if not data_url.startswith('data:') or ',' not in data_url:
        return 'application/octet-stream', data_url
    header, encoded = data_url.split(',', 1)
    mime_type = header.split(';', 1)[0].removeprefix('data:')
    return mime_type, encoded


@dataclass
class JobState:
    job_id: str
    session_id: str
    workspace_id: str
    prompt: str
    image_payload: dict[str, Any]
    status: str = 'queued'
    progress: float = 0.0
    message: str = 'Queued'
    result: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)


class MockBackendStore:
    def __init__(self, root_dir: Path, artifact_url: str, job_delay_s: float):
        self.root_dir = root_dir
        self.artifact_url = artifact_url
        self.job_delay_s = job_delay_s
        self.jobs: dict[str, JobState] = {}
        self.workspaces: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    @property
    def requests_dir(self) -> Path:
        return self.root_dir / 'data' / 'requests'

    @property
    def workspaces_dir(self) -> Path:
        return self.root_dir / 'data' / 'workspaces'

    def create_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = payload.get('sessionId', f'session-{uuid.uuid4()}')
        workspace_id = payload.get('workspaceId', 'workspace-local')
        prompt = payload.get('prompt', '')
        image_payload = payload.get('image', {})
        job_id = f'job-{uuid.uuid4()}'

        job = JobState(
            job_id=job_id,
            session_id=session_id,
            workspace_id=workspace_id,
            prompt=prompt,
            image_payload=image_payload,
        )
        with self._lock:
            self.jobs[job_id] = job

        self._persist_generation_request(job)

        worker = threading.Thread(target=self._run_job, args=(job_id,), daemon=True)
        worker.start()
        return {
            'jobId': job_id,
            'status': 'queued',
            'sessionId': session_id,
            'workspaceId': workspace_id,
        }

    def _persist_generation_request(self, job: JobState) -> None:
        payload = {
            'jobId': job.job_id,
            'sessionId': job.session_id,
            'workspaceId': job.workspace_id,
            'prompt': job.prompt,
            'createdAt': job.created_at,
        }
        _safe_write_json(self.requests_dir / f'{job.job_id}.json', payload)

        data_url = job.image_payload.get('dataUrl')
        if not data_url:
            return
        mime_type, encoded = _strip_data_url_prefix(data_url)
        suffix = '.bin'
        if mime_type == 'image/png':
            suffix = '.png'
        elif mime_type == 'image/jpeg':
            suffix = '.jpg'
        try:
            image_bytes = base64.b64decode(encoded)
        except Exception:
            logging.warning('Failed to decode request image for %s.', job.job_id)
            return
        image_path = self.requests_dir / f'{job.job_id}{suffix}'
        image_path.write_bytes(image_bytes)

    def _run_job(self, job_id: str) -> None:
        steps = [
            (0.15, 'Validating prompt and image'),
            (0.45, 'Encoding image and prompt'),
            (0.75, 'Mock SAM3D generation running'),
            (1.0, 'Finalizing asset'),
        ]
        delay_per_step = max(self.job_delay_s / len(steps), 0.1)

        for progress, message in steps:
            with self._lock:
                job = self.jobs.get(job_id)
                if not job:
                    return
                job.status = 'running'
                job.progress = progress
                job.message = message
            time.sleep(delay_per_step)

        asset_id = f'asset-{uuid.uuid4()}'
        latent_handle = f'latent-{uuid.uuid4()}'
        with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                return
            job.status = 'completed'
            job.progress = 1.0
            job.message = 'Completed'
            job.result = {
                'jobId': job.job_id,
                'status': 'completed',
                'sessionId': job.session_id,
                'workspaceId': job.workspace_id,
                'asset': {
                    'assetId': asset_id,
                    'glbUrl': self.artifact_url,
                    'thumbnailUrl': job.image_payload.get('dataUrl', ''),
                    'latentHandle': latent_handle,
                    'metadata': {'prompt': job.prompt},
                },
            }

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                return {
                    'jobId': job_id,
                    'status': 'failed',
                    'error': 'Unknown job id',
                }
            if job.status == 'completed' and job.result is not None:
                return job.result
            return {
                'jobId': job.job_id,
                'status': job.status,
                'progress': job.progress,
                'message': job.message,
            }

    def save_workspace(self, workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = {
            'workspaceId': workspace_id,
            'savedAt': int(time.time() * 1000),
            'workspace': payload.get('workspace', {}),
        }
        with self._lock:
            self.workspaces[workspace_id] = response
        _safe_write_json(self.workspaces_dir / f'{workspace_id}.json', response)
        return response

    def load_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        with self._lock:
            workspace = self.workspaces.get(workspace_id)
            if workspace is not None:
                return workspace
        path = self.workspaces_dir / f'{workspace_id}.json'
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding='utf-8'))


class MockBackendHandler(BaseHTTPRequestHandler):
    store: MockBackendStore

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/healthz':
            self._send_json({'ok': True})
            return

        if path.startswith('/jobs/'):
            job_id = path.removeprefix('/jobs/')
            self._send_json(self.store.get_job(job_id))
            return

        if path.startswith('/workspaces/'):
            workspace_id = path.removeprefix('/workspaces/')
            workspace = self.store.load_workspace(workspace_id)
            if workspace is None:
                self._send_json(
                    {'error': 'Workspace not found', 'workspaceId': workspace_id},
                    status=HTTPStatus.NOT_FOUND,
                )
                return
            self._send_json(workspace)
            return

        self._send_json({'error': 'Not found', 'path': path}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        payload = self._read_json_body()
        if payload is None:
            return

        if path == '/generate':
            response = self.store.create_job(payload)
            self._send_json(response, status=HTTPStatus.ACCEPTED)
            return

        if path.startswith('/workspaces/') and path.endswith('/save'):
            workspace_id = path.removeprefix('/workspaces/').removesuffix('/save')
            response = self.store.save_workspace(workspace_id, payload)
            self._send_json(response)
            return

        self._send_json({'error': 'Not found', 'path': path}, status=HTTPStatus.NOT_FOUND)

    def _read_json_body(self) -> dict[str, Any] | None:
        length_header = self.headers.get('Content-Length')
        if not length_header:
            self._send_json({'error': 'Missing Content-Length'}, status=HTTPStatus.BAD_REQUEST)
            return None
        raw = self.rfile.read(int(length_header))
        try:
            return json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError as exc:
            self._send_json(
                {'error': f'Invalid JSON body: {exc.msg}'},
                status=HTTPStatus.BAD_REQUEST,
            )
            return None

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self._send_cors_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_cors_headers(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info('%s - %s', self.address_string(), fmt % args)


def main() -> None:
    parser = argparse.ArgumentParser(description='SAM3D workspace mock backend')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--job-delay', type=float, default=12.0)
    parser.add_argument('--artifact-url', default=DEFAULT_MODEL_URL)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
    )

    root_dir = Path(__file__).resolve().parent
    store = MockBackendStore(
        root_dir=root_dir,
        artifact_url=args.artifact_url,
        job_delay_s=args.job_delay,
    )
    MockBackendHandler.store = store

    server = ThreadingHTTPServer(('127.0.0.1', args.port), MockBackendHandler)
    logging.info('Mock backend listening on http://127.0.0.1:%d', args.port)
    logging.info(
        'On Quest over USB, run: adb reverse tcp:%d tcp:%d',
        args.port,
        args.port,
    )
    logging.info(
        'Frontend sample URL: http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:%d',
        args.port,
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info('Shutting down mock backend.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()

