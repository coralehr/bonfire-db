/**
 * Public surface of per-agent worktree isolation (H3).
 */
export type { CreatedWorktree, WorktreeInfo } from "./worktree.js";
export {
  createWorktree,
  isAgentWorktree,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  WORKTREE_DIR,
  worktreeName,
  worktreePath
} from "./worktree.js";
