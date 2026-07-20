from pathlib import Path

import tomllib

from omni_migrator import __version__
from omni_migrator.ir.schema import Provenance


ROOT = Path(__file__).parent.parent


def test_release_version_is_consistent_with_the_frozen_upstream_lock_and_provenance():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    project_name = project["name"]
    project_version = project["version"]
    uv_document = tomllib.loads((ROOT / "uv.lock").read_text())
    frozen_project = next(package for package in uv_document["package"] if package["name"] == project_name)

    assert __version__ == project_version
    assert frozen_project["version"] == project_version
    assert Provenance().tool_version == project_version


def test_requirements_lock_contains_only_exact_uv_locked_distributions():
    project_name = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["name"]
    uv_document = tomllib.loads((ROOT / "uv.lock").read_text())
    uv_pairs = {
        (str(package["name"]).lower().replace("_", "-"), str(package["version"]))
        for package in uv_document["package"]
        if package["name"] != project_name
    }
    requirements = {}
    for line in (ROOT / "requirements.lock").read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        name, separator, version = stripped.partition("==")
        assert separator == "==", f"dependency is not exactly pinned: {stripped}"
        requirements[name.lower().replace("_", "-")] = version

    assert requirements
    assert all((name, version) in uv_pairs for name, version in requirements.items())

    direct_dependencies = {
        value.split(">=", 1)[0].strip().lower().replace("_", "-")
        for value in tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["dependencies"]
    }
    assert direct_dependencies <= requirements.keys()
