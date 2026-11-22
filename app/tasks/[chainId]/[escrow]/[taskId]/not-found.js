import Brand from "../../../../components/Brand";
export default function TaskNotFound() {
  return <main className="permissions-page page-width"><Brand href="/" /><h1>TASK NOT FOUND.</h1><p>This chain, escrow or task ID is not supported by the active marketplace. An ID from another contract must not be reused here.</p><a className="text-link" href="/#tasks">Browse the active task board →</a></main>;
}
