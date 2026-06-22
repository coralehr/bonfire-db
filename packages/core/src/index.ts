export interface HealthStatus {
  ok: true;
  service: "bonfire-api";
  version: string;
  dependencies: {
    database: "configured";
  };
}

export function getHealthStatus(): HealthStatus {
  return {
    ok: true,
    service: "bonfire-api",
    version: "0.0.0",
    dependencies: {
      database: "configured"
    }
  };
}
