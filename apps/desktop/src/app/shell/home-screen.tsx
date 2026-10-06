import {
  EmptyHome,
  HomeBootstrapScreen,
  useHomeBootstrap,
} from "@/features/home";
import { MainLayout } from "./main-layout";

/** Home: the start screen without projects, the Home shell with them. */
export function HomeScreen() {
  const { ready, hasProjects } = useHomeBootstrap();
  if (!ready) return <HomeBootstrapScreen />;
  return hasProjects ? <MainLayout view="home" /> : <EmptyHome />;
}
