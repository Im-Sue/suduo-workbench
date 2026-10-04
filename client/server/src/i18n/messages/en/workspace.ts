import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";
import type { FolderPermission } from "../zh-CN/workspace.js";

const PERMISSION_LIST = new Intl.ListFormat("en", { type: "conjunction" });

export const workspace = {
  project: {
    rootPathInvalid: "rootPath isn't valid",
    rootPathNotReadable: "rootPath must be an existing local folder you can read",
    removed: "This project was removed. Restore it explicitly with PATCH.",
    nameNotString: "Project name must be a string",
    stateActiveOnly: "Project state can only be active",
    patchEmpty: "PATCH must include at least one field",
    hasActiveSessions: "This project still has active sessions. Archive or delete them first.",
    notFound: "Project not found",
    nameLength: "Project name must be 1 to 200 characters",
    versionConflict: "The project was changed elsewhere (version conflict)",
    activeNotFound: "Project not found or no longer active",
  },
  mapping: {
    rootPathNotString: "rootPath must be a string",
    rootPathNotAbsolute: "rootPath must be an absolute path with no NUL characters",
    rootPathNotAccessible: "rootPath must be an existing local folder with read, write, and execute permissions",
    projectRemoved: "The project for this local folder was removed",
    linkedElsewhere: "This local folder is already linked to another project",
    missing: "This project isn't linked to a local folder yet",
    invalid: "The local folder link is no longer valid. Link the folder again.",
    changed: "The local folder link has changed. Link the folder again.",
    unsupportedQuery: "Unsupported query parameter",
    verifyInvalid: "verify only accepts 1",
  },
  mappingCheck: {
    notFound: "The local folder doesn't exist or can't be accessed",
    unresolvable: "The local folder can't be resolved or accessed",
    notDirectory: "The local folder path isn't a folder",
    statFailed: "Can't read the local folder's status",
    available: "Local folder is available",
    missingPermissions: (missing: readonly FolderPermission[]) =>
      `The local folder is missing ${PERMISSION_LIST.format(missing)} ${plural("en", missing.length, {
        one: "permission",
        other: "permissions",
      })}`,
  },
  path: {
    notFound: "File or folder not found",
    notFile: "The target isn't a file",
    notDirectory: "The target isn't a folder",
    outsideProject: "The path is outside the project folder",
    relativeRequired: "The path must be relative to the project folder",
    dotDot: "The path can't contain ..",
  },
  localDirectory: {
    notFolder: "This location isn't a folder",
    absoluteRequired: "Enter a full path that starts from the root",
    notFound: "This location doesn't exist",
    permissionDenied: "You don't have permission to access this location",
    unresolvable: "This path can't be resolved",
    readFailed: "Couldn't read the local folder",
    hiddenInvalid: "hidden must be 1 or 0",
    unsupportedQuery: (key: string) => `Unsupported query parameter: ${key}`,
    repeatedQuery: (key: string) => `Query parameter ${key} can only appear once`,
  },
  attachment: {
    fieldsInvalid: "The attachment request has invalid fields",
    typeUnsupported: "Attachments must be PNG, JPEG, GIF, or WebP images",
    base64Invalid: "The image's base64 data isn't valid",
    sizeInvalid: "Images must be between 1 byte and 10 MiB",
    contentMismatch: "The image content doesn't match its mediaType",
    remoteReadFailed: "Couldn't read the file from the server",
  },
  files: {
    skillsUnavailable: "The Codex runtime isn't available, so Skills can't be read right now",
    openFailed: "Couldn't open the file with a system app",
    diffNotFound: "No such file to diff",
    sessionNotFound: "Session not found",
    baselineInvalid: "The session baseline is invalid",
    storageDirOutsideProject: (path: string) =>
      `SuDuo's local storage folder ${path} points outside the project folder (possibly through a symbolic link), so nothing was written, for safety. Check the .suduo folder in the project.`,
  },
  git: {
    unavailable: "Git wasn't found on this computer, so version control can't be initialized",
    alreadyRepo: "This project is already a Git repository",
    notRepo: "This project isn't a Git repository",
    hashInvalid: "The commit hash isn't valid",
    commandFailed: (stderr: string) => `Git command failed: ${stderr}`,
    commandFailedPlain: "Git command failed",
  },
} satisfies ServerMessages["workspace"];
