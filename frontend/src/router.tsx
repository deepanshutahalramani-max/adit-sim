import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { RunsIndexPage } from "./routes/runs.index";
import { RunDetailPage } from "./routes/runs.$id";
import { NewRunPage } from "./routes/runs.new";
import { ScenariosIndexPage } from "./routes/scenarios.index";

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
        <span className="font-semibold text-brand-600 text-lg tracking-tight">
          ADIT Sim
        </span>
        <Link
          to="/runs"
          className="text-sm font-medium text-gray-600 hover:text-gray-900 [&.active]:text-brand-600 [&.active]:font-semibold"
        >
          Runs
        </Link>
        <Link
          to="/scenarios"
          className="text-sm font-medium text-gray-600 hover:text-gray-900 [&.active]:text-brand-600 [&.active]:font-semibold"
        >
          Scenarios
        </Link>
      </nav>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => {
    // Redirect to /runs
    window.location.replace("/runs");
    return null;
  },
});

const runsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsIndexPage,
});

const runsNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/new",
  component: NewRunPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunDetailPage,
});

const scenariosIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scenarios",
  component: ScenariosIndexPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  runsIndexRoute,
  runsNewRoute,
  runDetailRoute,
  scenariosIndexRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
