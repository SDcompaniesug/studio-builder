import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const OWNER = "SDcompaniesug";
const REPO = "studio-builder";
const GH_API = "https://api.github.com";
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
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
        if (!/^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) return fail("Invalid Android package name.");
        if (!validFiles(files)) return fail("Generated source files are missing or invalid.");
        const { rows } = await pool.query(
          `INSERT INTO studio_projects (name, package_name, description, technology, min_sdk, target_sdk, build_type, files)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           RETURNING id, name, package_name, description, technology, min_sdk, target_sdk, build_type, created_at, updated_at`,
          [name, packageName, description, technology, Number(minSdk), Number(targetSdk), String(buildType).toLowerCase(), JSON.stringify(files)]
        );
        return json({ project: rows[0], fileCount: files.length }, 201);
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
        const token = process.env.GITHUB_TOKEN;
        const archiveResponse = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/actions/artifacts/${artifact.id}/zip`, {
          headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          redirect: "manual"
        });
        const location = archiveResponse.headers.get("location");
        if (archiveResponse.status >= 300 && archiveResponse.status < 400 && location) return Response.redirect(location, 302);
        if (!archiveResponse.ok) throw new Error("GitHub artifact download failed: HTTP " + archiveResponse.status);
        return new Response(archiveResponse.body, { headers: { ...headers, "content-type": "application/zip", "content-disposition": `attachment; filename="studio-apk-${build.id}.zip"` } });
      }

      return fail("Route not found.", 404);
    } catch (error) {
      console.error(error);
      return fail(error.message || "Internal server error.", 500);
    }
  }
};
