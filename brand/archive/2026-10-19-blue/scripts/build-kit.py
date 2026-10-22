"""Package the production brand assets without historical AI mockups."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

brand = Path(__file__).resolve().parents[1]
root = brand.parent
target = brand / "assets/brand-kit.zip"
prefix = "Nodu-Brand-Kit"

with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for file in sorted((brand / "assets").rglob("*")):
        if not file.is_file() or any(part.endswith(".iconset") for part in file.parts):
            continue
        if file.name.startswith("nodu-brand-showcase") or file.suffix not in {".svg", ".png", ".json", ".ico", ".icns", ".md"}:
            continue
        archive.write(file, f"{prefix}/{file.relative_to(brand)}")
    readme = (brand / "README.md").read_text().replace("../docs/brand-name-research.md", "docs/brand-name-research.md")
    archive.writestr(f"{prefix}/README.md", readme)
    archive.write(root / "docs/brand-name-research.md", f"{prefix}/docs/brand-name-research.md")
    archive.write(root / "LICENSE", f"{prefix}/LICENSE")
    for file in sorted((brand / "scripts").iterdir()):
        if file.is_file():
            archive.write(file, f"{prefix}/scripts/{file.name}")

with ZipFile(target) as archive:
    bad = archive.testzip()
    if bad:
        raise RuntimeError(f"ZIP integrity failure: {bad}")
    print(f"Packaged {len(archive.namelist())} files; CRC verified; {target.stat().st_size} bytes")
