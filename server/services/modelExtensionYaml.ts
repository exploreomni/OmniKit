/** Omni represents the default relationships file as an empty YAML sequence. */
export function isEmptyModelExtensionRoot(fileName: string, root: unknown): boolean {
  if (root == null) return true;
  if (Array.isArray(root)) return fileName === 'relationships' && root.length === 0;
  return typeof root === 'object' && Object.getPrototypeOf(root) === Object.prototype && Object.keys(root).length === 0;
}
