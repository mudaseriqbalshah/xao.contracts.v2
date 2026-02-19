#!/usr/bin/env node

/**
 * Recursive Image Loader & Processor
 * 
 * Features:
 * - Recursively load images from all nested folders
 * - Copy all images to flat structure
 * - Rename sequentially across all folders
 * - Verify images across entire directory tree
 * - Generate detailed statistics
 * 
 * Usage:
 *   node recursiveImageLoader.js --scan ./traits
 *   node recursiveImageLoader.js --flatten ./traits ./output
 *   node recursiveImageLoader.js --tree ./traits
 *   node recursiveImageLoader.js --export-csv ./traits
 */

const fs = require("fs");
const path = require("path");

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log();
  log(`${"=".repeat(70)}`, "blue");
  log(`  ${title}`, "blue");
  log(`${"=".repeat(70)}\n`, "blue");
}

// ============================
// RECURSIVE FILE FINDER
// ============================
function findFilesRecursive(dir, extensions = []) {
  let files = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files and system files
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively search subdirectory
        files = files.concat(findFilesRecursive(fullPath, extensions));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Check if file matches extensions
        if (extensions.length === 0 || extensions.includes(ext)) {
          files.push({
            path: fullPath,
            name: entry.name,
            ext: ext,
            size: fs.statSync(fullPath).size,
            directory: dir,
            relativePath: path.relative(dir, fullPath),
          });
        }
      }
    }
  } catch (error) {
    log(`❌ Error reading directory ${dir}: ${error.message}`, "red");
  }

  return files;
}

// ============================
// SCAN & ANALYZE
// ============================
function scanImages(rootPath) {
  logSection("🔍 RECURSIVE IMAGE SCAN");

  if (!fs.existsSync(rootPath)) {
    log(`❌ Error: Path not found: ${rootPath}`, "red");
    return null;
  }

  const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  const files = findFilesRecursive(rootPath, imageExtensions);

  if (files.length === 0) {
    log(`❌ No images found in ${rootPath}`, "red");
    return null;
  }

  // Sort by name
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Group by directory
  const byDirectory = {};
  files.forEach((file) => {
    if (!byDirectory[file.directory]) {
      byDirectory[file.directory] = [];
    }
    byDirectory[file.directory].push(file);
  });

  // Calculate statistics
  let totalSize = 0;
  let minSize = Infinity;
  let maxSize = 0;
  let sizeByExt = {};

  files.forEach((file) => {
    totalSize += file.size;
    minSize = Math.min(minSize, file.size);
    maxSize = Math.max(maxSize, file.size);

    if (!sizeByExt[file.ext]) {
      sizeByExt[file.ext] = { count: 0, size: 0 };
    }
    sizeByExt[file.ext].count++;
    sizeByExt[file.ext].size += file.size;
  });

  const avgSize = totalSize / files.length;
  const totalSizeGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);
  const avgSizeMB = (avgSize / 1024 / 1024).toFixed(2);
  const minSizeMB = (minSize / 1024 / 1024).toFixed(2);
  const maxSizeMB = (maxSize / 1024 / 1024).toFixed(2);

  // Display results
  log(`✅ Found ${files.length} images recursively\n`, "green");

  log("📊 By Directory:", "cyan");
  Object.entries(byDirectory).forEach(([dir, dirFiles]) => {
    const dirSize = dirFiles.reduce((sum, f) => sum + f.size, 0);
    const dirSizeGB = (dirSize / 1024 / 1024 / 1024).toFixed(3);
    log(`   ${path.basename(dir) || "root"}: ${dirFiles.length} images (${dirSizeGB} GB)`, "gray");
  });

  log(`\n📊 By File Type:`, "cyan");
  Object.entries(sizeByExt).forEach(([ext, data]) => {
    const sizeGB = (data.size / 1024 / 1024 / 1024).toFixed(3);
    log(`   ${ext}: ${data.count} files (${sizeGB} GB)`, "gray");
  });

  log(`\n📊 Overall Statistics:`, "cyan");
  log(`   Total images: ${files.length}`, "gray");
  log(`   Total size: ${totalSizeGB} GB`, "gray");
  log(`   Average size: ${avgSizeMB} MB`, "gray");
  log(`   Min size: ${minSizeMB} MB`, "gray");
  log(`   Max size: ${maxSizeMB} MB`, "gray");
  log(`   Directories: ${Object.keys(byDirectory).length}`, "gray");

  // Show first and last files
  log(`\n📸 Sample Files:`, "cyan");
  files.slice(0, 5).forEach((f, i) => {
    const sizeMB = (f.size / 1024 / 1024).toFixed(2);
    log(`   ${f.relativePath} (${sizeMB} MB)`, "gray");
  });
  if (files.length > 10) {
    log(`   ...`, "gray");
    files.slice(-5).forEach((f) => {
      const sizeMB = (f.size / 1024 / 1024).toFixed(2);
      log(`   ${f.relativePath} (${sizeMB} MB)`, "gray");
    });
  }

  return { files, byDirectory, totalSize, stats: { totalSizeGB, avgSizeMB, minSizeMB, maxSizeMB } };
}

// ============================
// DISPLAY TREE
// ============================
function displayTree(rootPath, maxDepth = 5) {
  logSection("🌳 FOLDER TREE WITH IMAGE COUNTS");

  function displayDir(dir, prefix = "", depth = 0) {
    if (depth > maxDepth) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    let dirIndex = 0;
    const dirEntries = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
    const fileEntries = entries.filter((e) => e.isFile() && !e.name.startsWith("."));

    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
    const imageCount = fileEntries.filter((f) =>
      imageExtensions.includes(path.extname(f.name).toLowerCase())
    ).length;

    dirEntries.forEach((entry, i) => {
      const isLast = i === dirEntries.length - 1 && fileEntries.length === 0;
      const connector = isLast ? "└── " : "├── ";
      const extension = isLast ? "    " : "│   ";

      const subDir = path.join(dir, entry.name);
      const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
      const subImages = subEntries.filter((e) =>
        imageExtensions.includes(path.extname(e.name).toLowerCase())
      ).length;
      const subDirs = subEntries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).length;

      log(`${prefix}${connector}${entry.name}/ ${subDirs > 0 ? `[${subDirs} folders, ` : "["}${subImages} images]`, "magenta");

      displayDir(subDir, prefix + extension, depth + 1);
    });

    if (imageCount > 0) {
      const filesPrefix = fileEntries.length > 5 ? `${fileEntries.length} files` : fileEntries.map((f) => f.name).join(", ");
      log(`${prefix}   📄 ${filesPrefix}`, "cyan");
    }
  }

  log(path.basename(rootPath) + "/ (root)", "magenta");
  displayDir(rootPath);
}

// ============================
// FLATTEN & COPY
// ============================
function flattenImages(sourcePath, destPath, renameSequential = true) {
  logSection("📋 FLATTEN DIRECTORY STRUCTURE");

  const result = scanImages(sourcePath);
  if (!result) return;

  const { files } = result;

  // Create destination
  if (!fs.existsSync(destPath)) {
    fs.mkdirSync(destPath, { recursive: true });
    log(`✅ Created folder: ${destPath}\n`, "green");
  }

  log(`📋 Copying ${files.length} images to flat structure...\n`, "cyan");

  let copied = 0;
  let failed = 0;

  files.forEach((file, index) => {
    try {
      let newName;
      if (renameSequential) {
        newName = `${index}${file.ext}`;
      } else {
        newName = file.name;
      }

      const destFile = path.join(destPath, newName);

      fs.copyFileSync(file.path, destFile);
      copied++;

      if ((index + 1) % 500 === 0) {
        log(`   Copied ${index + 1}/${files.length}`, "cyan");
      }
    } catch (error) {
      failed++;
      log(`   ❌ Failed to copy ${file.name}: ${error.message}`, "red");
    }
  });

  log(`\n✅ Copied ${copied} images to ${destPath}`, "green");
  if (failed > 0) {
    log(`⚠️  Failed to copy ${failed} images`, "yellow");
  }

  if (renameSequential) {
    log(`✅ Renamed to: 0${files[0].ext}, 1${files[0].ext}, 2${files[0].ext} ... ${files.length - 1}${files[0].ext}`, "green");
  }
}

// ============================
// EXPORT TO CSV
// ============================
function exportToCSV(sourcePath, outputFile) {
  logSection("📊 EXPORT TO CSV");

  const result = scanImages(sourcePath);
  if (!result) return;

  const { files } = result;

  let csv = "Index,Filename,Path,Directory,Size (MB),File Type\n";

  files.forEach((file, i) => {
    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    const dirName = path.basename(file.directory) || "root";
    csv += `${i},"${file.name}","${file.relativePath}","${dirName}",${sizeMB},"${file.ext}"\n`;
  });

  fs.writeFileSync(outputFile, csv);
  log(`✅ Exported ${files.length} files to ${outputFile}`, "green");
}

// ============================
// VERIFY RECURSIVE
// ============================
function verifyRecursive(sourcePath) {
  logSection("🔍 VERIFY IMAGES RECURSIVELY");

  const result = scanImages(sourcePath);
  if (!result) return;

  const { files } = result;

  log(`\n🔍 Verifying ${files.length} images...`, "cyan");

  let valid = 0;
  let invalid = 0;
  let errors = [];

  files.forEach((file, i) => {
    try {
      const stats = fs.statSync(file.path);
      if (stats.size > 0) {
        valid++;
      } else {
        invalid++;
        errors.push(`${file.name} is empty (0 bytes)`);
      }

      if ((i + 1) % 500 === 0) {
        log(`   Verified ${i + 1}/${files.length}`, "cyan");
      }
    } catch (error) {
      invalid++;
      errors.push(`${file.name}: ${error.message}`);
    }
  });

  log(`\n✅ Valid: ${valid}`, "green");
  if (invalid > 0) {
    log(`❌ Invalid: ${invalid}`, "red");
    log(`\nErrors:`, "red");
    errors.slice(0, 10).forEach((err) => {
      log(`   - ${err}`, "red");
    });
    if (errors.length > 10) {
      log(`   ... and ${errors.length - 10} more errors`, "red");
    }
  } else {
    log(`\n🎉 All images are valid and ready!`, "green");
  }
}

// ============================
// MAIN
// ============================
const args = process.argv.slice(2);
const command = args[0];
const arg1 = args[1];
const arg2 = args[2];

if (!command) {
  log("\n📖 Usage:\n", "blue");
  log("   node recursiveImageLoader.js --scan <folder>", "cyan");
  log("      Scan all images recursively and show statistics\n", "gray");

  log("   node recursiveImageLoader.js --tree <folder>", "cyan");
  log("      Display folder structure with image counts\n", "gray");

  log("   node recursiveImageLoader.js --flatten <source> <output>", "cyan");
  log("      Copy all images from nested folders to flat structure\n", "gray");

  log("   node recursiveImageLoader.js --flatten <source> <output> --no-rename", "cyan");
  log("      Flatten without renaming (keep original names)\n", "gray");

  log("   node recursiveImageLoader.js --verify <folder>", "cyan");
  log("      Verify all images recursively\n", "gray");

  log("   node recursiveImageLoader.js --export-csv <folder> <output.csv>", "cyan");
  log("      Export image list to CSV file\n", "gray");

  log("📝 Examples:\n", "blue");
  log("   node recursiveImageLoader.js --scan ./traits", "cyan");
  log("   node recursiveImageLoader.js --tree ./traits", "cyan");
  log("   node recursiveImageLoader.js --flatten ./traits ./images", "cyan");
  log("   node recursiveImageLoader.js --verify ./traits", "cyan");
  log("   node recursiveImageLoader.js --export-csv ./traits ./images.csv\n", "cyan");

  process.exit(0);
}

try {
  switch (command) {
    case "--scan":
      if (!arg1) {
        log("❌ Error: --scan requires a folder path", "red");
        process.exit(1);
      }
      scanImages(arg1);
      break;

    case "--tree":
      if (!arg1) {
        log("❌ Error: --tree requires a folder path", "red");
        process.exit(1);
      }
      displayTree(arg1);
      break;

    case "--flatten":
      if (!arg1 || !arg2) {
        log("❌ Error: --flatten requires source and destination folders", "red");
        process.exit(1);
      }
      const noRename = args.includes("--no-rename");
      flattenImages(arg1, arg2, !noRename);
      break;

    case "--verify":
      if (!arg1) {
        log("❌ Error: --verify requires a folder path", "red");
        process.exit(1);
      }
      verifyRecursive(arg1);
      break;

    case "--export-csv":
      if (!arg1 || !arg2) {
        log("❌ Error: --export-csv requires folder and output CSV file", "red");
        process.exit(1);
      }
      exportToCSV(arg1, arg2);
      break;

    default:
      log(`❌ Unknown command: ${command}`, "red");
      log("Use --scan, --tree, --flatten, --verify, or --export-csv", "yellow");
      process.exit(1);
  }
} catch (error) {
  log(`❌ Error: ${error.message}`, "red");
  console.error(error);
  process.exit(1);
}

console.log();
