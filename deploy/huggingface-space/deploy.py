from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

DEFAULT_REPO_ID = "furukawa1020/sechack-experiment-demo"
DEFAULT_PUBLIC_URL = "https://furukawa1020-sechack-experiment-demo.static.hf.space/"
PRESERVED_REMOTE_FILES = frozenset({".gitattributes"})
ALLOWED_ASSET_SUFFIXES = frozenset({".css", ".js"})
HTML_TITLE_PATTERN = re.compile(rb"<title>[^<]+</title>")
HTML_ASSET_PATTERN = re.compile(
    rb'(?:href|src)="(?P<path>(?:\.\.?/)+assets/[^"?#]+)"'
)
REQUIRED_HTML_PATHS = frozenset(
    {
        "index.html",
        "operator/index.html",
        "display/demo/index.html",
        "device-test/index.html",
        "healthz/index.html",
    }
)


def collect_public_files(repository_root: Path) -> dict[str, Path]:
    readme = repository_root / "deploy" / "huggingface-space" / "README.md"
    distribution = repository_root / "dist-public-demo"
    assets = distribution / "assets"
    html_files = {
        relative_path: distribution / Path(relative_path)
        for relative_path in REQUIRED_HTML_PATHS
    }

    required_files = (readme, *html_files.values())
    missing = [str(path) for path in required_files if not path.is_file()]
    if not assets.is_dir():
        missing.append(str(assets))
    if missing:
        raise SystemExit(
            "公開デモを先にビルドしてください（npm.cmd run build:public-demo）。"
            f" 不足: {', '.join(missing)}"
        )

    asset_files = sorted(path for path in assets.rglob("*") if path.is_file())
    if not asset_files:
        raise SystemExit("dist-public-demo/assets に公開アセットがありません。")

    invalid_assets = [
        str(path)
        for path in asset_files
        if path.suffix.lower() not in ALLOWED_ASSET_SUFFIXES
    ]
    if invalid_assets:
        raise SystemExit(
            "公開対象外のアセットを検出しました: " + ", ".join(invalid_assets)
        )

    public_files = {"README.md": readme}
    public_files.update(html_files)
    for path in asset_files:
        relative_path = path.relative_to(distribution).as_posix()
        public_files[relative_path] = path
    return public_files


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="公開デモ（模擬表示）だけをHugging Face Static Spaceへ反映します。"
    )
    parser.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    parser.add_argument("--public-url", default=DEFAULT_PUBLIC_URL)
    parser.add_argument(
        "--commit-message",
        default="Deploy hardware-free static public demo",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="アップロード対象だけを表示し、外部変更を行いません。",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_committed_files(
    *,
    api: object,
    repo_id: str,
    revision: str,
    public_files: dict[str, Path],
    preserved_remote_files: set[str],
) -> None:
    from huggingface_hub import hf_hub_download

    remote_files = set(
        api.list_repo_files(repo_id, repo_type="space", revision=revision)  # type: ignore[attr-defined]
    )
    expected_files = set(public_files) | preserved_remote_files
    if remote_files != expected_files:
        missing = sorted(expected_files - remote_files)
        unexpected = sorted(remote_files - expected_files)
        raise SystemExit(
            f"公開commitのファイル一覧が不一致です。missing={missing}, unexpected={unexpected}"
        )

    for remote_path, local_path in sorted(public_files.items()):
        downloaded = Path(
            hf_hub_download(
                repo_id=repo_id,
                repo_type="space",
                revision=revision,
                filename=remote_path,
            )
        )
        if sha256_file(downloaded) != sha256_file(local_path):
            raise SystemExit(f"公開commitのSHA-256がローカル成果物と不一致です: {remote_path}")


def public_url_for_path(base: str, remote_path: str) -> str:
    if remote_path == "index.html":
        return base
    return urljoin(base, remote_path)


def add_revision_query(url: str, revision: str) -> str:
    parsed = urlsplit(url)
    query = urlencode({"revision": revision})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))


def verify_live_files(
    *,
    public_url: str,
    revision: str,
    public_files: dict[str, Path],
    timeout_seconds: int = 180,
) -> None:
    base = public_url.rstrip("/") + "/"
    base_parts = urlsplit(base)
    if base_parts.scheme != "https" or not base_parts.netloc:
        raise SystemExit("公開URLはhttpsの絶対URLで指定してください。")

    live_files = {
        remote_path: local_path
        for remote_path, local_path in public_files.items()
        if remote_path != "README.md"
    }
    deadline = time.monotonic() + timeout_seconds
    last_error = "未実行"
    while time.monotonic() < deadline:
        try:
            revision_request = Request(
                urljoin(base, "index.html"),
                headers={
                    "Cache-Control": "no-cache",
                    "User-Agent": "SecHack-public-deploy-audit/1",
                },
                method="HEAD",
            )
            with urlopen(revision_request, timeout=15) as revision_response:
                revision_parts = urlsplit(revision_response.geturl())
                if (
                    revision_parts.scheme != base_parts.scheme
                    or revision_parts.netloc != base_parts.netloc
                ):
                    raise RuntimeError(
                        "index.html redirected outside the public Space: "
                        f"{revision_response.geturl()}"
                    )
                if revision_response.status != 200:
                    raise RuntimeError(
                        f"index.html HEAD returned HTTP {revision_response.status}"
                    )
                live_revision = revision_response.headers.get("X-Repo-Commit")
                if live_revision != revision:
                    raise RuntimeError(
                        f"Space is not served from revision {revision}: "
                        f"X-Repo-Commit={live_revision!r}"
                    )

            for remote_path, local_path in sorted(live_files.items()):
                remaining_seconds = deadline - time.monotonic()
                if remaining_seconds <= 0:
                    raise TimeoutError("公開反映の待機期限を超過しました。")
                live_url = add_revision_query(
                    public_url_for_path(base, remote_path), revision
                )
                request = Request(
                    live_url,
                    headers={"Cache-Control": "no-cache", "User-Agent": "SecHack-public-deploy-audit/1"},
                    method="GET",
                )
                with urlopen(request, timeout=min(15, max(1, remaining_seconds))) as response:
                    final_parts = urlsplit(response.geturl())
                    if (
                        final_parts.scheme != base_parts.scheme
                        or final_parts.netloc != base_parts.netloc
                    ):
                        raise RuntimeError(
                            f"{remote_path} redirected outside the public Space: {response.geturl()}"
                        )
                    body = response.read()
                    if response.status != 200:
                        raise RuntimeError(f"{remote_path} returned HTTP {response.status}")
                    if local_path.suffix.lower() == ".html":
                        local_body = local_path.read_bytes()
                        expected_title = HTML_TITLE_PATTERN.search(local_body)
                        if expected_title is None:
                            raise RuntimeError(f"{remote_path} has no title in the local artifact")
                        expected_assets = {
                            match.group("path")
                            for match in HTML_ASSET_PATTERN.finditer(local_body)
                        }
                        if not expected_assets:
                            raise RuntimeError(
                                f"{remote_path} has no built asset reference in the local artifact"
                            )
                        required_markers = {
                            b'<div id="root"></div>',
                            expected_title.group(0),
                            *expected_assets,
                        }
                        missing_markers = [
                            marker.decode("utf-8")
                            for marker in required_markers
                            if marker not in body
                        ]
                        if missing_markers:
                            raise RuntimeError(
                                f"{remote_path} returned the wrong HTML document; "
                                f"missing={missing_markers}"
                            )
                    else:
                        live_sha256 = hashlib.sha256(body).hexdigest()
                        local_sha256 = sha256_file(local_path)
                        if live_sha256 != local_sha256:
                            raise RuntimeError(
                                f"{remote_path} SHA-256 mismatch: "
                                f"live={live_sha256}, local={local_sha256}"
                            )
            print(
                f"live revision, HTML markers, and asset SHA-256: PASS "
                f"({base}, {len(live_files)} files, revision {revision})"
            )
            return
        except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
            last_error = str(error)
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds > 0:
                time.sleep(min(3, remaining_seconds))
    raise SystemExit(f"公開URLが{timeout_seconds}秒以内に正常化しませんでした: {last_error}")


def main() -> None:
    args = parse_args()
    if args.repo_id != DEFAULT_REPO_ID and args.public_url == DEFAULT_PUBLIC_URL:
        raise SystemExit(
            "--repo-idを変更する場合は、対応する--public-urlも明示してください。"
        )
    repository_root = Path(__file__).resolve().parents[2]
    public_files = collect_public_files(repository_root)

    print("公開対象:")
    for path_in_repo in sorted(public_files):
        print(f"  {path_in_repo}")

    if args.dry_run:
        print("dry-run: 外部変更は行っていません。")
        return

    try:
        from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi
    except ModuleNotFoundError as error:
        raise SystemExit(
            "デプロイ用依存関係がありません。docs/PUBLIC_DEMO.mdの手順で"
            "deploy/huggingface-space/requirements.txtをインストールしてください。"
        ) from error

    api = HfApi()
    base_revision = api.repo_info(args.repo_id, repo_type="space").sha
    if not base_revision:
        raise SystemExit("配布先Spaceの基準commitを取得できませんでした。")
    remote_files = set(
        api.list_repo_files(
            args.repo_id,
            repo_type="space",
            revision=base_revision,
        )
    )
    preserved_remote_files = set(PRESERVED_REMOTE_FILES) & remote_files
    desired_remote_files = set(public_files) | preserved_remote_files

    operations = [
        CommitOperationDelete(path_in_repo=path)
        for path in sorted(remote_files - desired_remote_files)
    ]
    operations.extend(
        CommitOperationAdd(path_in_repo=remote_path, path_or_fileobj=local_path)
        for remote_path, local_path in sorted(public_files.items())
    )

    commit = api.create_commit(
        repo_id=args.repo_id,
        repo_type="space",
        revision="main",
        parent_commit=base_revision,
        operations=operations,
        commit_message=args.commit_message,
    )
    print(f"commit: {commit.oid}")
    print(f"URL: {commit.commit_url}")
    verify_committed_files(
        api=api,
        repo_id=args.repo_id,
        revision=commit.oid,
        public_files=public_files,
        preserved_remote_files=preserved_remote_files,
    )
    print("remote commit files and SHA-256: PASS")
    verify_live_files(
        public_url=args.public_url,
        revision=commit.oid,
        public_files=public_files,
    )


if __name__ == "__main__":
    main()
