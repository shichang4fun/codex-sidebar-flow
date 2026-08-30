const REQUIRED_SECTION_KEYS = Object.freeze(["inProgress", "forReview", "forLater"]);
const BUILT_IN_SECTION_IDS = new Set(["pinned", "chats", "threads"]);
const RESERVED_SECTION_NAMES = new Set(["pinned", "tasks", "projects", "chats"]);

function invalidSectionConfig(message) {
  const error = new Error(message);
  error.code = "INVALID_SECTION_CONFIG";
  return error;
}

export function validateSectionNames(sections) {
  if (sections == null || typeof sections !== "object" || Array.isArray(sections)) {
    throw invalidSectionConfig("Three configured section names are required");
  }
  const normalized = {};
  for (const key of REQUIRED_SECTION_KEYS) {
    const value = sections[key];
    if (
      typeof value !== "string"
      || value.length === 0
      || value.length > 128
      || value.trim() !== value
      || /[\u0000-\u001f\u007f]/.test(value)
      || RESERVED_SECTION_NAMES.has(value.toLowerCase())
    ) {
      throw invalidSectionConfig(`Invalid configured section name: ${key}`);
    }
    normalized[key] = value;
  }
  if (new Set(Object.values(normalized)).size !== REQUIRED_SECTION_KEYS.length) {
    throw invalidSectionConfig("Configured section names must be unique");
  }
  return normalized;
}

export function resolveConfiguredSections(sidebarSections, configuredNames) {
  const names = validateSectionNames(configuredNames);
  const resolved = {};
  for (const key of REQUIRED_SECTION_KEYS) {
    const matches = (sidebarSections ?? []).filter((section) => section?.name === names[key]);
    if (matches.length !== 1) {
      throw invalidSectionConfig(
        `Expected exactly one sidebar section named ${names[key]}; found ${matches.length}`,
      );
    }
    if (BUILT_IN_SECTION_IDS.has(matches[0].sectionId)) {
      throw invalidSectionConfig(`Configured section ${names[key]} must be a custom section`);
    }
    resolved[key] = matches[0];
  }
  if (new Set(Object.values(resolved).map((section) => section.sectionId)).size !== REQUIRED_SECTION_KEYS.length) {
    throw invalidSectionConfig("Configured sections must resolve to distinct custom sections");
  }
  return resolved;
}
