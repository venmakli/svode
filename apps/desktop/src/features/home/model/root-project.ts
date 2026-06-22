export interface CloningProject {
  name: string;
  path: string;
  phase: string;
  percent: number;
  error?: string;
}

export type CreateProjectSubmit = (
  name: string,
  icon: string,
  description: string | undefined,
  path: string,
) => void | Promise<void>;

export type CloneProjectSubmit = (
  url: string,
  targetPath: string,
) => void | Promise<void>;
