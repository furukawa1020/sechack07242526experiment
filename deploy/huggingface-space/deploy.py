from __future__ import annotations

import argparse
from pathlib import Path

DEFAULT_REPO_ID = "furukawa1020/sechack-experiment-demo"
PRESERVED_REMOTE_FILES = frozenset({".gitattributes"})
ALLOWED_ASSET_SUFFIXES = frozenset({".css", ".js"})


def collect_public_files(repository_root: Path) -> dict[str, Path]:
    readme = repository_root / "deploy" / "huggingface-space" / "README.md"
    distribution = repository_root / "dist-public-demo"
    index = distribution / "index.html"
    assets = distribution / "assets"

    required_paths = (readme, index, assets)
    missing = [str(path) for path in required_paths if not path.exists()]
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

    public_files = {"README.md": readme, "index.html": index}
    for path in asset_files:
        relative_path = path.relative_to(distribution).as_posix()
        public_files[relative_path] = path
    return public_files


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="公開MockデモだけをHugging Face Static Spaceへ反映します。"
    )
    parser.add_argument("--repo-id", default=DEFAULT_REPO_ID)
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


def main() -> None:
    args = parse_args()
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
    remote_files = set(api.list_repo_files(args.repo_id, repo_type="space"))
    desired_remote_files = set(public_files) | set(PRESERVED_REMOTE_FILES)

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
        operations=operations,
        commit_message=args.commit_message,
    )
    print(f"commit: {commit.oid}")
    print(f"URL: {commit.commit_url}")


if __name__ == "__main__":
    main()
