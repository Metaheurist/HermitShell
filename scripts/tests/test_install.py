"""scripts/install.sh copies the shared modules by name: every one a script imports must be on its list."""

import ast
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COMMON = REPO / "common"
PACKAGES = REPO / "packages"


def installed_common() -> set[str]:
    text = (REPO / "scripts" / "install.sh").read_text(encoding="utf-8")
    found = re.search(r"^for f in ([^;]+); do\s*\n\s*cp \"\$REPO/common/\$f\"", text, re.M)
    assert found, "install.sh no longer copies common/ with a for loop"
    return {name.removesuffix(".py") for name in found.group(1).split()}


def imports(path: Path) -> set[str]:
    names = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module.split(".")[0])
    return names


def test_every_shared_module_a_script_imports_is_installed():
    shared = {p.stem for p in COMMON.glob("*.py")}
    scripts = [p for p in COMMON.glob("*.py")] + [p for p in PACKAGES.glob("*/*.py")]
    needed = set().union(*(imports(p) for p in scripts)) & shared
    assert needed - installed_common() == set()


def test_the_list_names_only_real_modules():
    assert installed_common() <= {p.stem for p in COMMON.glob("*.py")}
