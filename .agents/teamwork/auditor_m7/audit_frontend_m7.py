import re

def audit_frontend(filepath):
    print(f"=== Auditing {filepath} ===")
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        lines = content.splitlines()

    print(f"Total lines: {len(lines)}")

    # 1. Check for Emojis
    # Common emoji ranges in unicode
    emoji_pattern = re.compile(
        r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]"
    )
    emoji_matches = []
    for idx, line in enumerate(lines, 1):
        found = emoji_pattern.findall(line)
        if found:
            emoji_matches.append((idx, found, line.strip()))
            
    print(f"\nEmoji check:")
    if emoji_matches:
        print(f"  WARNING: Found {len(emoji_matches)} lines with emojis:")
        for idx, f, l in emoji_matches[:10]:
            print(f"    Line {idx}: {f} -> {l}")
    else:
        print("  PASS: 0 emojis found in frontend code!")

    # 2. Check for Mock/Fake Data
    print("\nMock/Fake data pattern check:")
    mock_keywords = ["mock", "fake", "dummy", "sample_pipes", "sample_features", "stub"]
    mock_found = []
    for idx, line in enumerate(lines, 1):
        for kw in mock_keywords:
            if re.search(rf"\b{kw}\b", line, re.IGNORECASE):
                mock_found.append((idx, kw, line.strip()))
    if mock_found:
        print(f"  Found {len(mock_found)} occurrences:")
        for idx, kw, l in mock_found:
            print(f"    Line {idx} [{kw}]: {l}")
    else:
        print("  PASS: No mock data keywords found!")

    # 3. Check for API Endpoint calls
    print("\nAPI calls in frontend:")
    api_calls = re.findall(r"['\"]/api/[^'\"]+['\"]", content)
    for c in set(api_calls):
        print(f"  - {c}")

    # 4. Check layer count & color definitions
    print("\nChecking layer toggles in UI:")
    layers = ["storm", "sanitary", "water", "electric", "telecom", "gas", "ducts", "streetlights", "excavations", "as_built"]
    for lyr in layers:
        if lyr in content:
            print(f"  Layer '{lyr}': present")
        else:
            print(f"  Layer '{lyr}': MISSING")

    # 5. Check animated flow direction
    print("\nChecking animation flow direction implementation:")
    has_raf = "requestAnimationFrame" in content
    has_pulse = "flowPulse" in content or "pulse" in content or "flow" in content
    print(f"  requestAnimationFrame: {has_raf}")
    print(f"  flow animation logic: {has_pulse}")

if __name__ == "__main__":
    audit_frontend("web/src/12-public-utilities-gis.js")
