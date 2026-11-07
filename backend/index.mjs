import { Pool } from "pg";
import { zipSync, unzipSync, strToU8 } from "fflate";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const OWNER = "SDcompaniesug";
const REPO = "studio-builder";
const GH_API = "https://api.github.com";
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}
function fail(message, status = 400) { return json({ error: message }, status); }
async function body(req) {
  try { return await req.json(); } catch { throw new Error("Request body must be valid JSON."); }
}
function validFiles(files) {
  if (!Array.isArray(files) || !files.length) return false;
  if (files.length > 500) return false;
  return files.every(f => f && typeof f.path === "string" && typeof f.content === "string" &&
    f.path.length < 300 && f.content.length < 2_000_000 &&
    !f.path.startsWith("/") && !f.path.includes("..") &&
    !f.path.includes("\\") && !f.path.includes("\0"));
}
async function github(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GitHub build integration is not configured. Add GITHUB_TOKEN to the Neon Function environment.");
  const res = await fetch(GH_API + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
  if (!res.ok) throw new Error(data.message || ("GitHub HTTP " + res.status));
  return data;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (request.method === "GET" && path === "/") {
        return json({ service: "Studio Builder API", status: "ok", database: process.env.DATABASE_URL ? "configured" : "missing" });
      }
      if (request.method === "GET" && path === "/health/db") {
        try {
          const { rows } = await pool.query("SELECT now() AS server_time");
          return json({ status: "ok", database: "connected", serverTime: rows[0].server_time });
        } catch (error) {
          return fail("Database connection failed: " + error.message, 503);
        }
      }

      if (request.method === "POST" && path === "/projects") {
        const data = await body(request);
        const { name, packageName, description = "", technology = "Java + XML",
          minSdk = 24, targetSdk = 35, buildType = "Debug", files } = data;
        if (!name || !packageName || !description) return fail("name, packageName and description are required.");
        if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) return fail("Invalid Android package name.");
        if (!validFiles(files)) return fail("Generated source files are missing or invalid.");
        const { rows } = await pool.query(
          `INSERT INTO studio_projects (name, package_name, description, technology, min_sdk, target_sdk, build_type, files)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           RETURNING id, name, package_name, description, technology, min_sdk, target_sdk, build_type, created_at, updated_at`,
          [name, packageName, description, technology, Number(minSdk), Number(targetSdk), String(buildType).toLowerCase(), JSON.stringify(files)]
        );
        return json({ project: rows[0], fileCount: files.length }, 201);
      }

      if (request.method === "GET" && path === "/downloads") {
        const { rows } = await pool.query(`SELECT p.id AS project_id,p.name,p.package_name,p.updated_at,b.id AS build_id,b.build_type,b.status AS build_status,b.created_at AS build_created_at FROM studio_projects p LEFT JOIN LATERAL (SELECT id,build_type,status,created_at FROM studio_builds WHERE project_id=p.id ORDER BY created_at DESC LIMIT 1) b ON true ORDER BY p.updated_at DESC LIMIT 200`);
        return json({ downloads: rows.map(r => ({ ...r, zipUrl: `/projects/${r.project_id}/download`, apkUrl: r.build_status === "succeeded" && r.build_id ? `/builds/${r.build_id}/download` : null })) });
      }

      if (request.method === "GET" && path === "/projects") {
        const { rows } = await pool.query(
          `SELECT p.id,p.name,p.package_name,p.description,p.technology,p.min_sdk,p.target_sdk,p.build_type,p.created_at,p.updated_at,
             (SELECT count(*)::int FROM studio_builds b WHERE b.project_id=p.id) AS build_count,
             (SELECT b.id FROM studio_builds b WHERE b.project_id=p.id ORDER BY b.created_at DESC LIMIT 1) AS latest_build_id,
             (SELECT b.status FROM studio_builds b WHERE b.project_id=p.id ORDER BY b.created_at DESC LIMIT 1) AS latest_build_status
           FROM studio_projects p ORDER BY p.updated_at DESC LIMIT 200`
        );
        return json({ projects: rows });
      }

      const projectZipMatch = path.match(/^\/projects\/([0-9a-f-]{36})\/download$/i);
      if (request.method === "GET" && projectZipMatch) {
        const { rows } = await pool.query("SELECT id,name,files FROM studio_projects WHERE id=$1", [projectZipMatch[1]]);
        if (!rows.length) return fail("Project not found.", 404);
        const project = rows[0], entries = {};
        for (const file of project.files || []) entries[file.path] = strToU8(file.content);
        const archive = zipSync(entries, { level: 6 });
        const filename = (project.name || "android-project").replace(/[^a-z0-9_-]/gi, "_") + ".zip";
        return new Response(archive, { headers: { ...headers, "content-type": "application/zip", "content-length": String(archive.length), "content-disposition": 'attachment; filename="' + filename + '"' } });
      }

      const projectUpdateMatch = path.match(/^\/projects\/([0-9a-f-]{36})$/i);
      if (request.method === "PUT" && projectUpdateMatch) {
        const data = await body(request);
        if (!validFiles(data.files)) return fail("Updated project files are missing or invalid.");
        const { rows } = await pool.query(
          "UPDATE studio_projects SET files=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING id,name,package_name,updated_at",
          [projectUpdateMatch[1], JSON.stringify(data.files)]
        );
        if (!rows.length) return fail("Project not found.", 404);
        return json({ project: rows[0], fileCount: data.files.length });
      }

      const projectMatch = path.match(/^\/projects\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && projectMatch) {
        const { rows } = await pool.query(
          "SELECT id,name,package_name,description,technology,min_sdk,target_sdk,build_type,files,created_at,updated_at FROM studio_projects WHERE id=$1",
          [projectMatch[1]]
        );
        if (!rows.length) return fail("Project not found.", 404);
        return json({ project: rows[0] });
      }

      const sourceMatch = path.match(/^\/internal\/projects\/([0-9a-f-]{36})\/files$/i);
      if (request.method === "GET" && sourceMatch) {
        const { rows } = await pool.query("SELECT id,files FROM studio_projects WHERE id=$1", [sourceMatch[1]]);
        if (!rows.length) return fail("Project not found.", 404);
        return json({ projectId: rows[0].id, files: rows[0].files });
      }

      if (request.method === "POST" && path === "/builds") {
        const data = await body(request);
        const projectId = String(data.projectId || "");
        const buildType = String(data.buildType || "debug").toLowerCase();
        if (!/^[0-9a-f-]{36}$/i.test(projectId)) return fail("A valid projectId is required.");
        if (!["debug", "release"].includes(buildType)) return fail("buildType must be debug or release.");
        const project = await pool.query("SELECT id FROM studio_projects WHERE id=$1", [projectId]);
        if (!project.rows.length) return fail("Project not found.", 404);
        const buildId = crypto.randomUUID();
        await pool.query(
          "INSERT INTO studio_builds (id,project_id,build_type,status) VALUES ($1,$2,$3,'queued')",
          [buildId, projectId, buildType]
        );
        try {
          await pool.query("UPDATE studio_builds SET status='dispatching',updated_at=now() WHERE id=$1", [buildId]);
          await github(`/repos/${OWNER}/${REPO}/dispatches`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ event_type: "studio-build", client_payload: { buildId, projectId, buildType } })
          });
          await pool.query("UPDATE studio_builds SET status='running',updated_at=now() WHERE id=$1", [buildId]);
        } catch (e) {
          await pool.query("UPDATE studio_builds SET status='failed',error=$2,logs=$2,completed_at=now(),updated_at=now() WHERE id=$1", [buildId, e.message]);
          return fail(e.message, 502);
        }
        const { rows } = await pool.query("SELECT * FROM studio_builds WHERE id=$1", [buildId]);
        return json({ build: rows[0] }, 202);
      }

      const buildMatch = path.match(/^\/builds\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && buildMatch) {
        const { rows } = await pool.query("SELECT * FROM studio_builds WHERE id=$1", [buildMatch[1]]);
        if (!rows.length) return fail("Build not found.", 404);
        return json({ build: rows[0] });
      }

      const startMatch = path.match(/^\/internal\/builds\/([0-9a-f-]{36})\/start$/i);
      if (request.method === "POST" && startMatch) {
        const data = await body(request);
        const { rows } = await pool.query(
          "UPDATE studio_builds SET status='running',github_run_id=$2,github_run_url=$3,updated_at=now() WHERE id=$1 RETURNING id,status",
          [startMatch[1], data.runId || null, data.runUrl || null]
        );
        if (!rows.length) return fail("Build not found.", 404);
        return json({ ok: true, build: rows[0] });
      }

      const liveLogsMatch = path.match(/^\/builds\/([0-9a-f-]{36})\/logs$/i);
      if (request.method === "GET" && liveLogsMatch) {
        const { rows } = await pool.query("SELECT id,status,logs,github_run_id FROM studio_builds WHERE id=$1", [liveLogsMatch[1]]);
        if (!rows.length) return fail("Build not found.", 404);
        const build = rows[0];
        if (!build.github_run_id) return json({ status: build.status, logs: build.logs || "Waiting for GitHub Actions runner to start..." });
        try {
          const jobs = await github(`/repos/${OWNER}/${REPO}/actions/runs/${build.github_run_id}/jobs?per_page=100`);
          const output = [];
          for (const job of jobs.jobs || []) {
            output.push("=== "+job.name+" · "+job.status+(job.conclusion ? " · "+job.conclusion : "")+" ===");
            if (job.status === "completed") {
              const response = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/actions/jobs/${job.id}/logs`, {
                headers: { "Authorization": "Bearer " + process.env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
              });
              if (response.ok) {
                const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
                for (const [filename, bytes] of Object.entries(archive)) {
                  if (filename.endsWith(".txt")) output.push(new TextDecoder().decode(bytes));
                }
              }
            } else {
              output.push("Workflow step is running. Live output will appear when GitHub publishes the job log.");
            }
          }
          return json({ status: build.status, logs: output.join("\\n").slice(-50000) || build.logs || "Waiting for workflow logs..." });
        } catch (error) {
          return json({ status: build.status, logs: build.logs || "Workflow logs are not available yet: "+error.message });
        }
      }

      const resultMatch = path.match(/^\/internal\/builds\/([0-9a-f-]{36})\/result$/i);
      if (request.method === "POST" && resultMatch) {
        const data = await body(request);
        const status = ["succeeded", "failed"].includes(data.status) ? data.status : "failed";
        const logs = String(data.logs || "").slice(-50000);
        const error = data.error ? String(data.error).slice(0, 4000) : null;
        const { rows } = await pool.query(
          `UPDATE studio_builds SET status=$2,logs=$3,error=$4,github_run_id=$5,github_run_url=$6,
             completed_at=now(),updated_at=now() WHERE id=$1 RETURNING id,status`,
          [resultMatch[1], status, logs, error, data.runId || null, data.runUrl || null]
        );
        if (!rows.length) return fail("Build not found.", 404);
        return json({ ok: true, build: rows[0] });
      }

      const downloadMatch = path.match(/^\/builds\/([0-9a-f-]{36})\/download$/i);
      if (request.method === "GET" && downloadMatch) {
        const { rows } = await pool.query("SELECT id,status,github_run_id FROM studio_builds WHERE id=$1", [downloadMatch[1]]);
        if (!rows.length) return fail("Build not found.", 404);
        const build = rows[0];
        if (build.status !== "succeeded" || !build.github_run_id) return fail("APK is not ready yet.", 409);
        const artifacts = await github(`/repos/${OWNER}/${REPO}/actions/runs/${build.github_run_id}/artifacts`);
        const artifact = (artifacts.artifacts || []).find(a => a.name === "studio-apk-" + build.id && !a.expired);
        if (!artifact) return fail("APK artifact was not found. Check the GitHub Actions run.", 404);
        const response = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/actions/artifacts/${artifact.id}/zip`, {
          headers: { "Authorization": "Bearer " + process.env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
        });
        if (!response.ok) throw new Error("GitHub artifact download failed: HTTP " + response.status);
        const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
        const entry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith(".apk"));
        if (!entry) return fail("The build artifact did not contain an APK file.", 404);
        const [apkPath, apkBytes] = entry;
        const filename = (apkPath.split("/").pop() || "studio-builder.apk").replace(/["\\]/g, "_");
        return new Response(apkBytes, { headers: { ...headers, "content-type": "application/vnd.android.package-archive", "content-length": String(apkBytes.length), "content-disposition": 'attachment; filename="' + filename + '"', "cache-control": "private, no-store" } });
      }

      return fail("Route not found.", 404);
    } catch (error) {
      console.error(error);
      return fail(error.message || "Internal server error.", 500);
    }
  }
};
