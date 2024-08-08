const fs = require("fs");
const path = require("path");
const recursiveReaddir = require("recursive-readdir");
const { orderBy } = require("natural-orderby");
const LimitPromise = require("limit-promise");

const { joinFragments } = require("../routes/utils/url");
const { config } = require("../config");

const util = require("util");
const exec = util.promisify(require("child_process").exec);
const execFile = util.promisify(require("child_process").execFile);

const ffprobeStatic = require("ffprobe-static");

const supportedMediaExtList = [".mp3", ".ogg", ".opus", ".wav", ".aac", ".flac", ".webm", ".mp4", ".m4a", ".mka"];
const supportedSubtitleExtList = [".lrc", ".srt", ".ass", ".vtt"]; // '.ass' only support show on file list, not for play lyric
const supportedImageExtList = [".jpg", ".jpeg", ".png", ".webp"];
const supportedExtList = ["txt", "pdf"] + supportedImageExtList + supportedMediaExtList + supportedSubtitleExtList;

function uniqueArr(arr, val) {
  const res = new Map();
  return arr.filter((item) => !res.has(item[val]) && res.set(item[val], 1));
}

/**
 * 限制 processFolder 并发数量，
 * 使用控制器包装 processFolder 方法，实际上是将请求函数递交给控制器处理
 */
async function getAudioFileDuration(filePath) {
  try {
    // 默认环境中已经安装了ffprobe命令
    const { stdout } = await execFile(ffprobeStatic.path, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const durationSecs = parseFloat(stdout);
    return durationSecs;
  } catch (err) {
    console.error(`get duration failed, file = ${filePath}`, err);
  }
  return NaN;
}
const limitP = new LimitPromise(config.maxParallelism); // 核心控制器
const getAudioFileDurationLimited = (filePath) => limitP.call(getAudioFileDuration, filePath);

/**
 * Returns list of playable tracks in a given folder. Track is an object
 * containing 'title', 'subtitle' and 'hash'.
 * @param {String} id Work identifier. Currently, RJ/RE code.
 * @param {String} dir Work directory (absolute).
 */
const getTrackList = async function (id, dir) {
  try {
    const files = await recursiveReaddir(dir);
    // Filter out any files not matching these extensions
    const filteredFiles = files.filter((file) => {
      const ext = path.extname(file).toLowerCase();

      return supportedExtList.includes(ext);
    });

    // Sort by folder and title
    const sortedFiles = orderBy(
      filteredFiles.map((file) => {
        const shortFilePath = file.replace(path.join(dir, "/"), "");
        const dirName = path.dirname(shortFilePath);

        return {
          title: path.basename(file),
          subtitle: dirName === "." ? null : dirName,
          ext: path.extname(file),
          fullPath: file,
        };
      }),
      [(v) => v.subtitle, (v) => v.title, (v) => v.ext]
    );

    // Add hash to each file
    const sortedHashedFiles = sortedFiles.map((file, index) => ({
      title: file.title,
      subtitle: file.subtitle,
      duration: file.duration,
      hash: `${id}/${index}`,
      fullPath: file.fullPath, // 为后续获取音频时长提供完整文件路径
      ext: file.ext,
    }));

    // Add duration to each audio file
    const addDurationFiles = await Promise.all(
      sortedHashedFiles.map(async (file) => {
        if (supportedMediaExtList.includes(file.ext)) {
          file.duration = await getAudioFileDurationLimited(file.fullPath);
        }
        delete file.fullPath;
        delete file.shortFilePath;

        return file;
      })
    );
    return addDurationFiles;
  } catch (err) {
    throw new Error(`Failed to get tracklist from disk: ${err}`);
  }
};

async function getWorkDuration(id, workPath) { 
  const tracks = await limitP.call(getTrackList, id, workPath);
  let duration = 0.0;
  const tracksList = tracks.map((track) => {
    track.title = track.title.replace(track.ext, "");
    return track;
  });
  const uniqueTracks = uniqueArr(tracksList, "title");
  uniqueTracks.forEach((track) => {
    if (supportedMediaExtList.includes(track.ext)) {
      duration += track.duration;
    }
  });
  return duration;
}

/**
 * 转换成树状结构
 * @param {Array} tracks
 * @param {String} workTitle
 */
const toTree = (tracks, workTitle, workDir, rootFolder) => {
  const tree = [];

  // 插入文件夹
  tracks.forEach((track) => {
    let fatherFolder = tree;
    const path = track.subtitle ? track.subtitle.split("\\") : [];
    path.forEach((folderName) => {
      const index = fatherFolder.findIndex((item) => item.type === "folder" && item.title === folderName);
      if (index === -1) {
        fatherFolder.push({
          type: "folder",
          title: folderName,
          children: [],
        });
      }
      fatherFolder = fatherFolder.find((item) => item.type === "folder" && item.title === folderName).children;
    });
  });

  // 插入文件
  tracks.forEach((track) => {
    let fatherFolder = tree;
    const paths = track.subtitle ? track.subtitle.split("\\") : [];
    paths.forEach((folderName) => {
      fatherFolder = fatherFolder.find((item) => item.type === "folder" && item.title === folderName).children;
    });

    // Path controlled by config.offloadMedia, config.offloadStreamPath and config.offloadDownloadPath
    // If config.offloadMedia is enabled, by default, the paths are:
    // /media/stream/VoiceWork/RJ123456/subdirs/track.mp3
    // /media/download//VoiceWork/RJ123456/subdirs/track.mp3
    //
    // If the folder is deeper:
    // /media/stream/VoiceWork/second/RJ123456/subdirs/track.mp3
    // /media/download/VoiceWork/second/RJ123456/subdirs/track.mp3
    // console.log("track", track);
    let offloadStreamUrl = joinFragments(
      config.offloadStreamPath,
      rootFolder.name,
      workDir,
      track.subtitle || "",
      track.title
    );
    let offloadDownloadUrl = joinFragments(
      config.offloadDownloadPath,
      rootFolder.name,
      workDir,
      track.subtitle || "",
      track.title
    );
    if (process.platform === "win32") {
      offloadStreamUrl = offloadStreamUrl.replace(/\\/g, "/");
      offloadDownloadUrl = offloadDownloadUrl.replace(/\\/g, "/");
    }

    const textBaseUrl = "/api/media/stream/";
    const mediaStreamBaseUrl = "/api/media/stream/";
    const mediaDownloadBaseUrl = "/api/media/download/";
    const textStreamBaseUrl = textBaseUrl + track.hash; // Handle charset detection internally with jschardet
    const textDownloadBaseUrl = config.offloadMedia ? offloadDownloadUrl : mediaDownloadBaseUrl + track.hash;
    const mediaStreamUrl = config.offloadMedia ? offloadStreamUrl : mediaStreamBaseUrl + track.hash;
    const mediaDownloadUrl = config.offloadMedia ? offloadDownloadUrl : mediaDownloadBaseUrl + track.hash;

    if ((["txt"] + supportedSubtitleExtList).includes(track.ext)) {
      fatherFolder.push({
        type: "text",
        hash: track.hash,
        title: track.title,
        workTitle,
        mediaStreamUrl: textStreamBaseUrl,
        mediaDownloadUrl: textDownloadBaseUrl,
      });
    } else if (supportedImageExtList.includes(track.ext)) {
      fatherFolder.push({
        type: "image",
        hash: track.hash,
        title: track.title,
        workTitle,
        mediaStreamUrl,
        mediaDownloadUrl,
      });
    } else if (track.ext === ".pdf") {
      fatherFolder.push({
        type: "other",
        hash: track.hash,
        title: track.title,
        workTitle,
        mediaStreamUrl,
        mediaDownloadUrl,
      });
    } else {
      fatherFolder.push({
        type: "audio",
        hash: track.hash,
        title: track.title,
        duration: track.duration,
        workTitle,
        mediaStreamUrl,
        mediaDownloadUrl,
      });
    }
  });

  return tree;
};

/**
 * 返回一个成员为指定根文件夹下所有包含 RJ 号的音声文件夹对象的数组，
 * 音声文件夹对象 { relativePath: '相对路径', rootFolderName: '根文件夹别名', id: '音声ID' }
 * @param {Object} rootFolder 根文件夹对象 { name: '别名', path: '绝对路径' }
 */
async function* getFolderList(rootFolder, current = "", depth = 0, callback = function addMainLog() {}) {
  // 异步生成器函数 async function*() {}
  // 浅层遍历
  const folders = await fs.promises.readdir(path.join(rootFolder.path, current));

  for (const folder of folders) {
    const absolutePath = path.resolve(rootFolder.path, current, folder);
    const relativePath = path.join(current, folder);
    const mtime = fs.statSync(absolutePath).mtime;
    const dateStr = mtime.toLocaleDateString("zh-cn", { year: "numeric", month: "2-digit", day: "2-digit" });
    const timeStr = mtime.toLocaleTimeString("zh-cn", { hour12: false });
    const addTime = `${dateStr.replace(/\//g, "-")} ${timeStr}`;

    try {
      // eslint-disable-next-line no-await-in-loop
      if ((await fs.promises.stat(absolutePath)).isDirectory()) {
        // 检查是否为文件夹
        if (folder.match(/RJ\d+/)) {
          // 检查文件夹名称中是否含有RJ号
          // Found a work folder, don't go any deeper.
          yield {
            absolutePath,
            relativePath,
            rootFolderName: rootFolder.name,
            addTime: addTime,
            id: folder.match(/RJ(\d+)/)[1],
          };
        } else if (depth + 1 < config.scannerMaxRecursionDepth) {
          // 若文件夹名称中不含有RJ号，就进入该文件夹内部
          // Found a folder that's not a work folder, go inside if allowed.
          yield* getFolderList(rootFolder, relativePath, depth + 1);
        }
      }
    } catch (err) {
      if (err.code === "EPERM") {
        if (err.path && !err.path.endsWith("System Volume Information")) {
          console.log(" ! 无法访问", err.path);
          callback({
            level: "info",
            message: ` ! 无法访问 ${err.path}`,
          });
        }
      } else {
        throw err;
      }
    }
  }
}

/**
 * Deletes a work's cover image from disk.
 * @param {String} rjcode Work RJ code (only the 6 digits, zero-padded).
 */
const deleteCoverImageFromDisk = (rjcode) =>
  new Promise((resolve, reject) => {
    const types = ["main", "sam", "240x240", "360x360"];
    types.forEach((type) => {
      try {
        fs.unlinkSync(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`));
      } catch (err) {
        reject(err);
      }
    });

    resolve();
  });

/**
 * Saves cover image to disk.
 * @param {ReadableStream} stream Image data stream.
 * @param {String} rjcode Work RJ code (only the 6 digits, zero-padded).
 * @param {String} types img type: ('main', 'sam', 'sam@2x', 'sam@3x', '240x240', '360x360').
 */
const saveCoverImageToDisk = (stream, rjcode, type) =>
  new Promise((resolve, reject) => {
    // TODO: don't assume image is a jpg?
    try {
      stream.pipe(
        fs
          .createWriteStream(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`))
          .on("close", () => resolve())
      );
    } catch (err) {
      reject(err);
    }
  });

function formatRJCode(id) {
  if (id >= 1000000) {
    id = `0${id}`.slice(-8);
  } else {
    id = `000000${id}`.slice(-6);
  }
  return id;
}

module.exports = {
  formatRJCode,
  getAudioFileDurationLimited,
  getTrackList,
  getWorkDuration,
  toTree,
  getFolderList,
  deleteCoverImageFromDisk,
  saveCoverImageToDisk,
};