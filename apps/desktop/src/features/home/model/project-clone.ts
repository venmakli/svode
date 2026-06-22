const URL_REGEX =
  /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)\S+|^[\w.-]+@[\w.-]+:\S+$/;

export function isProjectCloneUrlValid(url: string): boolean {
  return URL_REGEX.test(url);
}

export function projectNameFromCloneUrl(url: string, fallback = "project") {
  return (
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") || fallback
  );
}

export function projectCloneTargetPath(
  targetFolder: string,
  url: string,
): string {
  const repoName = projectNameFromCloneUrl(url, "");
  return targetFolder && repoName ? `${targetFolder}/${repoName}` : "";
}
