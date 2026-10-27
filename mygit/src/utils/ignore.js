import fs from 'fs';
import path from 'path';

export function loadIgnore(gitRoot) {
  const repoRoot = path.dirname(gitRoot);
  const ignorePath = path.join(repoRoot, '.gitbroignore');
  
  // Base ignores that are always active
  const rules = ['.gitbro', '.git', 'node_modules', '.gitignore'];
  
  if (fs.existsSync(ignorePath)) {
    const content = fs.readFileSync(ignorePath, 'utf8');
    const lines = content.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // filter empty and comments
    rules.push(...lines);
  }
  
  return Array.from(new Set(rules));
}

export function isIgnored(relPath, rules) {
  const parts = relPath.split('/').filter(Boolean);
  
  return rules.some(rule => {
    rule = rule.trim();
    if (!rule) return false;
    
    // 1. Check if ANY segment matches the rule (for core folders like .gitbro, node_modules)
    const isCoreRoot = ['.gitbro', '.git', 'node_modules'].includes(rule);
    if (isCoreRoot && parts.some(p => p === rule)) return true;

    // 2. Handle **/ patterns (match at any depth)
    if (rule.startsWith('**/')) {
      const remainder = rule.slice(3); // Remove '*/'
      // Check if this path contains the remainder as a segment or directory
      return relPath.includes('/' + remainder) || relPath.startsWith(remainder);
    }
    
    // 3. Handle directory patterns ending with / (e.g., "node_modules/", ".angular/")
    if (rule.endsWith('/')) {
      const dirName = rule.slice(0, -1); // Remove trailing '/'
      // Match if this directory appears anywhere in the path
      return parts.some(p => p === dirName) || relPath.startsWith(dirName + '/');
    }
    
    // 4. Handle simple filename patterns (e.g., "build.gradle", "settings.gradle")
    // These should match the filename anywhere in the path
    if (!rule.includes('/') && !rule.startsWith('*') && !rule.startsWith('.')) {
      const filename = parts[parts.length - 1]; // Get the last segment (filename)
      if (filename === rule) return true;
    }
    
    // 5. Handle patterns with dots but no slashes (e.g., ".gradle", ".angular", "*.class")
    if (!rule.includes('/')) {
      if (rule.startsWith('*.')) {
        // Wildcard extension: *.class matches any .class file
        if (relPath.endsWith(rule.slice(1))) return true;
      } else if (rule.startsWith('.')) {
        // Hidden files/folders: .gradle matches any .gradle file
        const filename = parts[parts.length - 1];
        if (filename === rule) return true;
      }
    }
    
    // 6. Exact match for specific rules
    if (relPath === rule) return true;
    
    // 7. Directory prefix match
    if (relPath.startsWith(rule + '/')) return true;
    
    return false;
  });
}
