/**
 * ClawPress Build Relay Server
 * 
 * Receives prompts from the chatbox widget, runs a Claude tool-use agent loop
 * against the WordPress REST API, and returns results.
 * 
 * This IS the agentic loop — Claude decides what to do, calls WordPress tools,
 * checks the results, and iterates until the site is built.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3847;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WP_SITE = process.env.WP_SITE;           // e.g. https://sampletestsite2.newspackstaging.com
const WP_USER = process.env.WP_USER || 'bob';
const WP_PASS = process.env.WP_PASS;           // app password

if (!ANTHROPIC_API_KEY || !WP_SITE || !WP_PASS) {
  console.error('Required env vars: ANTHROPIC_API_KEY, WP_SITE, WP_PASS');
  process.exit(1);
}

const WP_AUTH = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

app.use(cors());
app.use(express.json());

// ── WordPress Tool Definitions ───────────────────────────────────────────────

const tools = [
  {
    name: 'wp_get_site_info',
    description: 'Get basic site information (title, description, URL, timezone)',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'wp_update_site_options',
    description: 'Update site title and/or tagline',
    input_schema: {
      type: 'object',
      properties: {
        blogname: { type: 'string', description: 'Site title' },
        blogdescription: { type: 'string', description: 'Site tagline' },
      },
      required: []
    }
  },
  {
    name: 'wp_get_global_styles',
    description: 'Get the current global styles (colors, fonts, spacing). Returns the theme.json settings and styles.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'wp_update_global_styles',
    description: 'Update global styles (colors, fonts, spacing, typography). Pass a theme.json v3 object with settings and/or styles to merge.',
    input_schema: {
      type: 'object',
      properties: {
        settings: { type: 'object', description: 'Theme.json settings (color palettes, typography, etc.)' },
        styles: { type: 'object', description: 'Theme.json styles (background, text, elements, blocks)' },
      },
      required: []
    }
  },
  {
    name: 'wp_list_pages',
    description: 'List all pages on the site',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'wp_create_page',
    description: 'Create a new page with title, content (HTML), and optional status',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title' },
        content: { type: 'string', description: 'Page content (HTML with WordPress blocks)' },
        status: { type: 'string', enum: ['publish', 'draft'], description: 'Page status (default: publish)' },
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'wp_update_page',
    description: 'Update an existing page by ID',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Page ID' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content (HTML)' },
      },
      required: ['id']
    }
  },
  {
    name: 'wp_delete_page',
    description: 'Delete a page by ID',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Page ID to delete' },
      },
      required: ['id']
    }
  },
  {
    name: 'wp_create_post',
    description: 'Create a new blog post',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Post content (HTML)' },
        status: { type: 'string', enum: ['publish', 'draft'], description: 'Post status' },
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'wp_list_menus',
    description: 'List navigation menus',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'wp_create_menu',
    description: 'Create a navigation menu with items',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Menu name' },
        content: { type: 'string', description: 'Menu content as WordPress navigation block HTML' },
      },
      required: ['name', 'content']
    }
  },
  {
    name: 'wp_set_homepage',
    description: 'Set a page as the site homepage (sets show_on_front to "page")',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'number', description: 'Page ID to set as homepage' },
      },
      required: ['page_id']
    }
  },
  {
    name: 'wp_get_theme_mods',
    description: 'Get current theme modifications via ClawPress Theme Bridge',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'wp_set_theme_mods',
    description: 'Set theme modifications via ClawPress Theme Bridge',
    input_schema: {
      type: 'object',
      properties: {
        mods: { type: 'object', description: 'Key-value pairs of theme mods to set' },
      },
      required: ['mods']
    }
  },
  {
    name: 'wp_update_template_part',
    description: 'Create or update a template part (header or footer). Use this to replace the default theme header/footer with custom content.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Template part slug: "header" or "footer"' },
        content: { type: 'string', description: 'WordPress block HTML content for the template part' },
      },
      required: ['slug', 'content']
    }
  },
  {
    name: 'search_and_upload_image',
    description: 'Search for a real image using OpenVerse (Creative Commons), download it, and upload it to the WordPress media library. Returns the WordPress media URL. Use this instead of guessing Unsplash URLs. Always use this tool when you need images for hero sections, galleries, or any visual content.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for the image (e.g. "Sacramento Tower Bridge", "vending machine office", "portland photographer studio")' },
        filename: { type: 'string', description: 'Filename for the uploaded image (e.g. "hero-bridge.jpg")' },
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL and extract its readable text content. Use this to research an existing website before rebuilding or redesigning it. Returns the page title, meta description, and main text content (truncated to 8000 chars). Great for understanding a site\'s structure, copy, and purpose.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (e.g. https://example.com)' },
      },
      required: ['url']
    }
  },
];

// ── WordPress Tool Execution ─────────────────────────────────────────────────

async function wpFetch(path, options = {}) {
  const url = `${WP_SITE}/wp-json${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': WP_AUTH,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  return res.json();
}

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'wp_get_site_info':
        return await wpFetch('/');

      case 'wp_update_site_options': {
        const results = {};
        if (input.blogname) {
          await wpFetch('/wp/v2/settings', {
            method: 'POST',
            body: JSON.stringify({ title: input.blogname }),
          });
          results.blogname = input.blogname;
        }
        if (input.blogdescription) {
          await wpFetch('/wp/v2/settings', {
            method: 'POST',
            body: JSON.stringify({ description: input.blogdescription }),
          });
          results.blogdescription = input.blogdescription;
        }
        return results;
      }

      case 'wp_get_global_styles': {
        const gsId = await wpFetch('/clawpress/v1/theme-bridge/global-styles-id');
        if (!gsId?.id) return { error: 'No global styles found' };
        const gs = await wpFetch(`/wp/v2/global-styles/${gsId.id}`);
        return { id: gsId.id, settings: gs.settings, styles: gs.styles };
      }

      case 'wp_update_global_styles': {
        const gsId = await wpFetch('/clawpress/v1/theme-bridge/global-styles-id');
        if (!gsId?.id) return { error: 'No global styles found' };
        
        // Get existing
        const existing = await wpFetch(`/wp/v2/global-styles/${gsId.id}`);
        const merged = {
          settings: deepMerge(existing.settings || {}, input.settings || {}),
          styles: deepMerge(existing.styles || {}, input.styles || {}),
        };
        
        const result = await wpFetch(`/wp/v2/global-styles/${gsId.id}`, {
          method: 'POST',
          body: JSON.stringify(merged),
        });
        return { success: true, id: gsId.id };
      }

      case 'wp_list_pages':
        return await wpFetch('/wp/v2/pages?per_page=50');

      case 'wp_create_page': {
        console.log(`      → Creating page: "${input.title}" (${input.content?.length || 0} chars)`);
        const pageResult = await wpFetch('/wp/v2/pages', {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            content: input.content,
            status: input.status || 'publish',
            template: input.template || 'page-no-title',
          }),
        });
        if (pageResult.id) {
          console.log(`      ← Created page ${pageResult.id}: "${pageResult.title?.rendered}"`);
        } else {
          console.log(`      ← FAILED: ${JSON.stringify(pageResult).substring(0, 200)}`);
        }
        return pageResult;
      }

      case 'wp_update_page': {
        const payload = {
          ...(input.title && { title: input.title }),
          ...(input.content && { content: input.content }),
        };
        console.log(`      → wp_update_page ${input.id}: title=${!!input.title}, content=${input.content ? input.content.length + ' chars' : 'none'}`);
        const result = await wpFetch(`/wp/v2/pages/${input.id}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (result.code) console.log(`      ← Error: ${result.code} - ${result.message}`);
        return result;
      }

      case 'wp_delete_page':
        return await wpFetch(`/wp/v2/pages/${input.id}?force=true`, { method: 'DELETE' });

      case 'wp_create_post':
        // T&S: Layer 3 output scan + rate limiting hook here before publish
        //       see projects/clawpress/trust-safety/
        return await wpFetch('/wp/v2/posts', {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            content: input.content,
            status: input.status || 'publish',
          }),
        });

      case 'wp_list_menus':
        return await wpFetch('/wp/v2/navigation?per_page=50');

      case 'wp_create_menu':
        return await wpFetch('/wp/v2/navigation', {
          method: 'POST',
          body: JSON.stringify({
            title: input.name,
            content: input.content,
            status: 'publish',
          }),
        });

      case 'wp_set_homepage': {
        await wpFetch('/wp/v2/settings', {
          method: 'POST',
          body: JSON.stringify({
            show_on_front: 'page',
            page_on_front: input.page_id,
          }),
        });
        return { success: true, homepage: input.page_id };
      }

      case 'wp_get_theme_mods':
        return await wpFetch('/clawpress/v1/theme-bridge/theme-mods');

      case 'wp_set_theme_mods':
        return await wpFetch('/clawpress/v1/theme-bridge/theme-mods', {
          method: 'POST',
          body: JSON.stringify(input.mods),
        });

      case 'search_and_upload_image': {
        console.log(`      → Searching OpenVerse for: "${input.query}"`);
        try {
          // Search OpenVerse (Automattic's CC image search)
          const searchUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(input.query)}&page_size=5&license_type=commercial`;
          const searchRes = await fetch(searchUrl);
          const searchData = await searchRes.json();
          
          if (!searchData.results || searchData.results.length === 0) {
            return { error: 'No images found for query: ' + input.query };
          }
          
          // Pick the first result
          const image = searchData.results[0];
          const imageUrl = image.url;
          console.log(`      → Found: ${image.title} (${imageUrl})`);
          
          // Download the image
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) {
            return { error: 'Failed to download image from ' + imageUrl };
          }
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
          const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          const ext = contentType.includes('png') ? 'png' : 'jpg';
          const fname = input.filename || `image-${Date.now()}.${ext}`;
          
          console.log(`      → Downloaded ${imgBuffer.length} bytes, uploading to WP...`);
          
          // Upload to WordPress media library
          const uploadRes = await fetch(`${WP_SITE}/wp-json/wp/v2/media`, {
            method: 'POST',
            headers: {
              'Authorization': WP_AUTH,
              'Content-Disposition': `attachment; filename="${fname}"`,
              'Content-Type': contentType,
            },
            body: imgBuffer,
          });
          const uploadData = await uploadRes.json();
          
          if (uploadData.id) {
            console.log(`      → Uploaded as media ID ${uploadData.id}: ${uploadData.source_url}`);
            return { 
              success: true, 
              id: uploadData.id, 
              url: uploadData.source_url,
              title: image.title,
              attribution: image.attribution || image.creator,
              license: image.license,
            };
          } else {
            return { error: 'Upload failed: ' + JSON.stringify(uploadData) };
          }
        } catch (e) {
          console.error('      → Image search/upload error:', e.message);
          return { error: 'Image search failed: ' + e.message };
        }
      }

      case 'fetch_url': {
        console.log(`      → Fetching URL: ${input.url}`);
        try {
          const res = await fetch(input.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
              'Accept': 'text/html',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(10000),
          });
          const html = await res.text();
          
          // Extract title
          const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : '';
          
          // Extract meta description
          const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
          const description = metaMatch ? metaMatch[1].trim() : '';
          
          // Extract text content — strip tags, scripts, styles
          let text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, ' [NAV] ')
            .replace(/<header[\s\S]*?<\/header>/gi, ' [HEADER] ')
            .replace(/<footer[\s\S]*?<\/footer>/gi, ' [FOOTER] ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#?\w+;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          // Extract links for site structure
          const linkMatches = [...html.matchAll(/<a[^>]*href=["']([^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi)];
          const internalLinks = linkMatches
            .filter(m => m[1].startsWith('/') || m[1].includes(new URL(input.url).hostname))
            .map(m => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() }))
            .filter(l => l.text && l.text.length < 100)
            .slice(0, 30);
          
          // Truncate text
          if (text.length > 8000) text = text.substring(0, 8000) + '... [truncated]';
          
          console.log(`      → Fetched: "${title}" (${text.length} chars)`);
          return { title, description, text, links: internalLinks, url: input.url };
        } catch (e) {
          console.error(`      → Fetch error: ${e.message}`);
          return { error: 'Failed to fetch URL: ' + e.message };
        }
      }

      case 'wp_update_template_part': {
        // Get the active theme slug first
        const themeInfo = await wpFetch('/wp/v2/themes?status=active');
        const themeSlug = Array.isArray(themeInfo) && themeInfo[0] 
          ? themeInfo[0].stylesheet 
          : 'twentytwentyfive';
        const tpId = `${themeSlug}//${input.slug}`;
        console.log(`      → Updating template part: ${tpId}`);
        const result = await wpFetch(`/wp/v2/template-parts/${encodeURIComponent(tpId)}`, {
          method: 'POST',
          body: JSON.stringify({
            content: input.content,
          }),
        });
        return { success: true, slug: input.slug, id: result.id || tpId };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Agent Loop ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the ClawPress Build site builder. You build complete WordPress websites from a single prompt — sites that look like a good designer made them, not like a template was filled in.

You have tools to interact with a WordPress site: set titles, configure global styles, create pages, build navigation, customize header/footer templates, search and upload real images. If the user provides a URL, use fetch_url to research the existing site first.

DESIGN PHILOSOPHY:

You are a designer, not a template engine. Every site should have a point of view. When someone says "coffee shop," don't reach for safe browns and cream — ask yourself: what KIND of coffee shop? A third-wave pour-over bar looks nothing like a truck stop diner. Read the prompt for personality cues and amplify them.

Surprise over safety. The default instinct is to play it safe — dark backgrounds for "modern," pastels for "friendly." Push past that. A BBQ joint could be stark white with bold black type and one fire-engine red accent. A yoga studio could be dark and moody instead of expected sage green. The best designs have one unexpected choice.

TYPOGRAPHY IS PERSONALITY. Use Google Fonts through the global styles API. A serif headline font completely changes the feel. Mix weights dramatically: a thin sans-serif body with a heavy display heading creates tension that's interesting.

Suggested pairings (pick based on vibe, don't repeat across builds):
- Bold & editorial: DM Serif Display + Inter
- Warm & crafted: Playfair Display + Source Sans 3
- Clean & modern: Space Grotesk + DM Sans
- Rustic & grounded: Bitter + Work Sans
- Playful & fresh: Sora + Nunito
- Elegant & minimal: Cormorant Garamond + Raleway

COLOR WITH INTENTION:
- Start from the business personality, not a generic palette generator
- Use ONE bold accent color, not three. Restraint > variety
- Background doesn't have to be white or dark gray. Consider warm off-whites (#FAF7F2), subtle tinted backgrounds, or a single full-color section that breaks the rhythm
- Dark palettes: light text must be truly white or near-white, never gray
- WCAG AA minimum (4.5:1 contrast ratio) — non-negotiable

LAYOUT HAS RHYTHM. Alternate section densities: a dense content section followed by a breathing spacer. A full-bleed hero followed by narrow centered text. This creates visual rhythm that makes the page feel designed, not stacked.

COPY WITH VOICE, NOT FILLER. Every business has a personality. Match the copy voice to the business:
- Food truck: casual, confident, a little cocky. "We sell out early. That's not bragging — that's a warning."
- Photographer: quiet confidence. Let the work speak. Short sentences. Intentional.
- Nonprofit: warm but direct. Don't be sappy. Show impact, not feelings.
- SaaS: clear and sharp. No jargon. What does it do, who is it for, why now.
Never use "Welcome to our website" or "We are passionate about..." — that's the smell of a template.

BUILD PROCESS:
1. Check current site state (get site info, list existing pages)
2. Update site title and tagline
3. Search and upload images (max 2-3, ALL at once in one iteration before creating pages)
4. Set global styles — color palette, typography (Google Fonts), spacing. This is where personality lives.
5. Create pages with rich content using WordPress blocks
6. Set the homepage
7. Create navigation menu
8. Create custom header and footer template parts

TECHNICAL RULES (NON-NEGOTIABLE):
- Use WordPress block HTML (<!-- wp:paragraph -->, <!-- wp:heading -->, etc.)
- Phone numbers: tel: links. Emails: mailto: links.
- Max 2 columns in wp:columns. More looks terrible on mobile.
- All content needs horizontal padding (min 20px). Never flush against viewport edge.
- Never include the page title in content — the theme renders it.
- Header template: site name + nav only. No wp:post-title block.
- Hero/cover sections: alignfull, zero gap below header. Use wp:cover with uploaded image URL.
- Hero images must be relevant to the business. Use the search_and_upload_image tool. NEVER guess URLs.
- Limit image searches to MAX 2-3 total. Use emoji or icon characters for section decorations instead.
- Navigation: real anchors (#section-id) for single-page, real page links for multi-page. No dead links.
- For single-page sites, add id attributes to sections matching the anchor nav.
- MANDATORY: Create custom header AND footer template parts. Without these, the site shows broken default chrome with "Blog, About, FAQs, Authors" links — unacceptable.
- Footer: branded, business contact info, relevant links. Styled to match palette.
- Be efficient. {success: true} means saved — don't verify. Never update the same page twice.
- Build in order. Don't backtrack.
- When done: brief summary (2-3 lines). "✅ [Site Name] is live!" Keep it short.`;

async function runAgentLoop(userMessages, modelOverride = null) {
  const messages = [...userMessages];
  let iterations = 0;
  const MAX_ITERATIONS = 15;
  const toolCallCounts = {}; // Track repeated calls
  const buildManifest = []; // Capture every tool call for replay

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    buildIteration = iterations;
    console.log(`  Agent loop iteration ${iterations}...`);

    const response = await client.messages.create({
      model: modelOverride || 'claude-sonnet-4-6',
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Check if we're done (no more tool calls)
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return { reply: textBlock?.text || 'Done!', iterations, manifest: buildManifest };
    }

    // Process tool calls — parallel execution for speed
    const toolResults = [];
    const textParts = [];
    const toolBlocks = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      }
      if (block.type === 'tool_use') {
        toolBlocks.push(block);
      }
    }

    // Execute all tool calls in parallel
    const toolPromises = toolBlocks.map(async (block) => {
      console.log(`    Tool: ${block.name}(${JSON.stringify(block.input).substring(0, 100)}...)`);
      
      // Loop detection — if same tool+target called 2+ times, force move on
      const callKey = `${block.name}:${block.input.id || block.input.page_id || block.input.title || block.input.query || block.input.slug || 'nokey'}`;
      toolCallCounts[callKey] = (toolCallCounts[callKey] || 0) + 1;
      if (toolCallCounts[callKey] > 2) {
        console.log(`    ⚠️ Loop detected: ${callKey} called ${toolCallCounts[callKey]} times, forcing success`);
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ success: true, note: 'Already saved successfully. Move on to the next task.' }),
        };
      }
      
      const result = await executeTool(block.name, block.input);
      
      // Update the current tool label for status polling
      currentToolLabel = TOOL_LABELS[block.name] || 'WordPressing...';
      
      // Capture for build manifest (skip read-only calls)
      if (!block.name.startsWith('wp_get_') && !block.name.startsWith('wp_list_')) {
        const manifestEntry = { tool: block.name, input: block.input };
        if (result.id) manifestEntry.resultId = result.id;
        if (result.url) manifestEntry.resultUrl = result.url;
        if (result.source_url) manifestEntry.resultUrl = result.source_url;
        if (result.link) manifestEntry.resultLink = result.link;
        if (result.title?.rendered) manifestEntry.resultTitle = result.title.rendered;
        if (result.slug) manifestEntry.resultSlug = result.slug;
        if (result.success !== undefined) manifestEntry.success = result.success;
        if (result.error || result.code) manifestEntry.error = result.message || result.error || result.code;
        buildManifest.push(manifestEntry);
        emitBuildEvent('mutation', { tool: block.name, label: currentToolLabel, iteration: iterations });
      }
      
      // Slim down responses to save context
      let resultStr;
      if (result.code || result.error) {
        resultStr = JSON.stringify({ error: result.message || result.error || result.code });
      } else if (block.name.startsWith('wp_create_') || block.name === 'wp_update_page' || block.name === 'wp_create_post') {
        const slim = { success: true, id: result.id, title: result.title?.rendered || result.title };
        if (result.link) slim.link = result.link;
        if (result.status) slim.status = result.status;
        resultStr = JSON.stringify(slim);
      } else {
        resultStr = JSON.stringify(result);
        if (resultStr.length > 4000) {
          resultStr = resultStr.substring(0, 4000) + '... [truncated]';
        }
      }
      
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: resultStr,
      };
    });

    const resolvedResults = await Promise.all(toolPromises);
    toolResults.push(...resolvedResults);

    // Add assistant response and tool results to messages
    messages.push({ role: 'assistant', content: response.content });
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return { reply: 'Reached maximum iterations. The site may be partially built.', iterations };
}

// ── OpenAI Agent Loop ────────────────────────────────────────────────────────

// Convert Anthropic tool schema to OpenAI function format
const openaiTools = tools.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }
}));

async function runOpenAIAgentLoop(userMessages, modelName = 'gpt-5.4', tempOverride = null) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...userMessages,
  ];
  let iterations = 0;
  const MAX_ITERATIONS = 15;
  const toolCallCounts = {};
  const buildManifest = [];

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    buildIteration = iterations;
    console.log(`  [OpenAI] Agent loop iteration ${iterations}...`);

    const response = await openaiClient.chat.completions.create({
      model: modelName,
      max_completion_tokens: 16384,
      temperature: tempOverride ?? 0.9,
      tools: openaiTools,
      messages,
    });

    const choice = response.choices[0];

    // Done?
    if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
      return { reply: choice.message.content || 'Done!', iterations, manifest: buildManifest };
    }

    // Add assistant message with tool calls
    messages.push(choice.message);

    // Execute tool calls in parallel
    const toolCalls = choice.message.tool_calls || [];
    const toolPromises = toolCalls.map(async (tc) => {
      const fnName = tc.function.name;
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      
      console.log(`    Tool: ${fnName}(${JSON.stringify(input).substring(0, 100)}...)`);
      
      const callKey = `${fnName}:${input.id || input.page_id || input.title || input.query || input.slug || 'nokey'}`;
      toolCallCounts[callKey] = (toolCallCounts[callKey] || 0) + 1;
      if (toolCallCounts[callKey] > 2) {
        return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ success: true, note: 'Already saved. Move on.' }) };
      }
      
      const result = await executeTool(fnName, input);
      currentToolLabel = TOOL_LABELS[fnName] || 'WordPressing...';
      
      if (!fnName.startsWith('wp_get_') && !fnName.startsWith('wp_list_')) {
        const me = { tool: fnName, input };
        if (result.id) me.resultId = result.id;
        if (result.url) me.resultUrl = result.url;
        if (result.success !== undefined) me.success = result.success;
        buildManifest.push(me);
        emitBuildEvent('mutation', { tool: fnName, label: currentToolLabel, iteration: iterations });
      }
      
      let resultStr;
      if (result.code || result.error) {
        resultStr = JSON.stringify({ error: result.message || result.error || result.code });
      } else if (fnName.startsWith('wp_create_') || fnName === 'wp_update_page' || fnName === 'wp_create_post') {
        const slim = { success: true, id: result.id, title: result.title?.rendered || result.title };
        if (result.link) slim.link = result.link;
        resultStr = JSON.stringify(slim);
      } else {
        resultStr = JSON.stringify(result);
        if (resultStr.length > 4000) resultStr = resultStr.substring(0, 4000) + '... [truncated]';
      }
      
      return { role: 'tool', tool_call_id: tc.id, content: resultStr };
    });

    const toolResults = await Promise.all(toolPromises);
    messages.push(...toolResults);
  }

  return { reply: 'Reached maximum iterations.', iterations };
}

// ── Deep Merge Helper ────────────────────────────────────────────────────────

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// ── HTTP Endpoints ───────────────────────────────────────────────────────────

// Simple mutex — one session at a time
let busy = false;
let busySince = null;
let busyMode = null; // 'building' or 'resetting'
let lastCompletedMode = null; // Track what just finished for status banner
let buildIteration = 0;
let buildMaxIterations = 15;
let currentToolLabel = ''; // Human-friendly label for current tool

// Tool name → personality label mapping
const TOOL_LABELS = {
  'wp_get_site_info': 'Thinking...',
  'wp_update_site_options': 'Organizing...',
  'wp_get_global_styles': 'Thinking...',
  'wp_update_global_styles': 'Styling...',
  'wp_list_pages': 'Thinking...',
  'wp_create_page': 'Writing...',
  'wp_update_page': 'Editing...',
  'wp_delete_page': 'Organizing...',
  'wp_create_post': 'Writing...',
  'wp_list_menus': 'Thinking...',
  'wp_create_menu': 'Organizing...',
  'wp_set_homepage': 'Finishing...',
  'wp_get_theme_mods': 'Thinking...',
  'wp_set_theme_mods': 'Styling...',
  'wp_update_template_part': 'Finishing...',
  'search_and_upload_image': 'Searching...',
  'fetch_url': 'Searching...',
};
const BUSY_TIMEOUT = 300000; // 5 min max
let currentBuildId = null;
const buildResults = new Map(); // buildId → { status, reply, error, iterations, manifest }

// Fire-and-forget build endpoint — returns immediately with buildId
app.post('/build', (req, res) => {
  // Auto-release stale locks
  if (busy && busySince && (Date.now() - busySince > BUSY_TIMEOUT)) {
    console.log('⚠️ Auto-releasing stale build lock');
    busy = false;
  }

  if (busy) {
    return res.json({
      error: 'Someone else is redesigning the site right now. Try again in a few minutes!',
      busy: true,
    });
  }

  const { messages, model, temperature } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const buildId = `build-${Date.now()}`;
  currentBuildId = buildId;
  busy = true;
  busySince = Date.now();
  busyMode = 'building';
  lastCompletedMode = null;
  buildIteration = 0;
  currentToolLabel = 'Starting...';

  buildResults.set(buildId, { status: 'building', startedAt: new Date().toISOString() });
  emitBuildEvent('build-start', { buildId });

  // Return immediately — build runs in background
  res.json({ buildId, status: 'building' });

  // Run the build async
  const userPrompt = messages.filter(m => m.role === 'user').map(m => m.content).join(' | ');
  const logEntry = { timestamp: new Date().toISOString(), prompt: userPrompt };
  console.log(`\n🦞 New build session: ${buildId}`);
  console.log(`   Prompt: ${userPrompt}`);

  // Route to correct agent loop based on model
  // Default to OpenAI (gpt-5.4). Use Anthropic only if explicitly requested.
  const isAnthropic = model && model.startsWith('claude-');
  const buildPromise = isAnthropic 
    ? runAgentLoop(messages, model) 
    : runOpenAIAgentLoop(messages, model || 'gpt-5.4', temperature || null);
  
  buildPromise
    .then(result => {
      console.log(`✅ ${buildId} complete in ${result.iterations} iterations`);
      logEntry.iterations = result.iterations;
      logEntry.status = 'success';
      lastCompletedMode = 'building';
      currentToolLabel = '';

      // Store result for client retrieval
      buildResults.set(buildId, {
        status: 'complete',
        reply: result.reply,
        iterations: result.iterations,
        completedAt: new Date().toISOString(),
      });

      // Emit completion with reply text so SSE clients get it
      emitBuildEvent('build-complete', { buildId, reply: result.reply, iterations: result.iterations });

      appendFileSync('builds.log', JSON.stringify(logEntry) + '\n');
      const manifestFile = `builds/${buildId}.json`;
      mkdirSync('builds', { recursive: true });
      writeFileSync(manifestFile, JSON.stringify({
        prompt: userPrompt,
        timestamp: logEntry.timestamp,
        iterations: result.iterations,
        steps: result.manifest || [],
      }, null, 2));
      console.log(`   Manifest saved: ${manifestFile}`);
    })
    .catch(err => {
      console.error(`❌ ${buildId} error:`, err.message);
      logEntry.status = 'error';
      logEntry.error = err.message;

      buildResults.set(buildId, {
        status: 'error',
        error: 'Something went wrong building the site. Try again!',
        completedAt: new Date().toISOString(),
      });

      emitBuildEvent('build-error', { buildId, error: 'Something went wrong building the site.' });
      appendFileSync('builds.log', JSON.stringify(logEntry) + '\n');
    })
    .finally(() => {
      busy = false;
      busySince = null;
      busyMode = null;
      // Clean up old results (keep last 10)
      if (buildResults.size > 10) {
        const oldest = [...buildResults.keys()].slice(0, buildResults.size - 10);
        oldest.forEach(k => buildResults.delete(k));
      }
    });
});

// Get build result (for reconnection / polling fallback)
app.get('/build/:id', (req, res) => {
  const result = buildResults.get(req.params.id);
  if (!result) return res.status(404).json({ error: 'Build not found' });
  res.json(result);
});

// Legacy /chat endpoint — redirect to /build
app.post('/chat', (req, res) => {
  // Forward to /build for backward compat
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  if (busy) {
    return res.json({
      error: 'Someone else is redesigning the site right now. Try again in a few minutes!',
      busy: true,
    });
  }

  // For legacy clients: simulate sync behavior by polling until done
  res.json({ error: 'Please use POST /build instead. The /chat endpoint is deprecated.', deprecated: true });
});

app.get('/status', (req, res) => {
  res.json({ ok: true, busy, mode: busyMode, lastCompletedMode, buildId: currentBuildId, iteration: buildIteration, maxIterations: buildMaxIterations, toolLabel: currentToolLabel, version: '0.5.0' });
});

// SSE endpoint for live build updates
const sseClients = new Set();
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function emitBuildEvent(type, data = {}) {
  const msg = JSON.stringify({ type, ...data });
  for (const client of sseClients) {
    client.write(`data: ${msg}\n\n`);
  }
}

// ── Reset Endpoint ───────────────────────────────────────────────────────────

const PROTECTED_PAGE_IDS = [3]; // Privacy Policy only

app.post('/reset', async (req, res) => {
  if (busy) {
    return res.json({ error: 'Site is busy building. Wait for it to finish first.' });
  }
  
  busy = true;
  busySince = Date.now();
  busyMode = 'resetting';
  lastCompletedMode = null;
  
  try {
    console.log('\n🧹 Resetting site...');
    
    // 0. Delete all posts
    console.log('  Step 0: Deleting posts...');
    const posts = await wpFetch('/wp/v2/posts?per_page=100');
    console.log(`  Found ${Array.isArray(posts) ? posts.length : 'non-array: ' + JSON.stringify(posts).substring(0, 200)} posts`);
    if (Array.isArray(posts)) {
      for (const post of posts) {
        await wpFetch(`/wp/v2/posts/${post.id}?force=true`, { method: 'DELETE' });
        console.log(`  Deleted post ${post.id}: ${post.title?.rendered}`);
      }
    }
    
    // 0b. Delete all media
    console.log('  Step 0b: Deleting media...');
    const media = await wpFetch('/wp/v2/media?per_page=100');
    console.log(`  Found ${Array.isArray(media) ? media.length : 'non-array'} media`);
    if (Array.isArray(media)) {
      for (const item of media) {
        await wpFetch(`/wp/v2/media/${item.id}?force=true`, { method: 'DELETE' });
        console.log(`  Deleted media ${item.id}: ${item.title?.rendered}`);
      }
    }
    
    // 1. Delete all non-protected pages
    console.log('  Step 1: Deleting pages...');
    const pages = await wpFetch('/wp/v2/pages?per_page=100');
    console.log(`  Found ${Array.isArray(pages) ? pages.length : 'non-array: ' + JSON.stringify(pages).substring(0, 200)} pages`);
    if (Array.isArray(pages)) {
      for (const page of pages) {
        if (!PROTECTED_PAGE_IDS.includes(page.id)) {
          await wpFetch(`/wp/v2/pages/${page.id}?force=true`, { method: 'DELETE' });
          console.log(`  Deleted page ${page.id}: ${page.title?.rendered}`);
        }
      }
    }
    
    // 2. Delete all navigation menus
    const menus = await wpFetch('/wp/v2/navigation?per_page=100');
    if (Array.isArray(menus)) {
      for (const menu of menus) {
        await wpFetch(`/wp/v2/navigation/${menu.id}?force=true`, { method: 'DELETE' });
        console.log(`  Deleted nav menu ${menu.id}`);
      }
    }
    
    // 3. Reset site title and tagline
    await wpFetch('/wp/v2/settings', {
      method: 'POST',
      body: JSON.stringify({
        title: 'My New Site',
        description: 'Just another WordPress site',
        show_on_front: 'posts',
        page_on_front: 0,
      }),
    });
    console.log('  Reset site title/tagline/homepage');
    
    // 4. Reset template parts (header/footer) — must delete custom overrides to revert to theme defaults
    const templateParts = await wpFetch('/wp/v2/template-parts?per_page=100');
    if (Array.isArray(templateParts)) {
      for (const part of templateParts) {
        if (part.source === 'custom') {
          const result = await wpFetch(`/wp/v2/template-parts/${encodeURIComponent(part.id)}?force=true`, { method: 'DELETE' });
          console.log(`  Reset template part: ${part.id} (was custom) → ${result.deleted ? 'deleted' : JSON.stringify(result).substring(0, 100)}`);
        }
      }
    }

    // 5. Reset global styles to defaults
    const gsId = await wpFetch('/clawpress/v1/theme-bridge/global-styles-id');
    if (gsId?.id) {
      await wpFetch(`/wp/v2/global-styles/${gsId.id}`, {
        method: 'POST',
        body: JSON.stringify({
          settings: {},
          styles: {},
        }),
      });
      console.log('  Reset global styles');
    }
    
    // Purge Cloudflare cache if possible, and flush WP object cache
    try {
      await wpFetch('/clawpress/v1/theme-bridge/flush-cache', { method: 'POST' });
    } catch (e) { /* best effort */ }
    
    console.log('✅ Site reset complete');
    lastCompletedMode = 'resetting';
    res.json({ ok: true, message: 'Site has been reset to a blank slate.' });
  } catch (err) {
    console.error('Reset error:', err.message);
    res.json({ error: 'Reset failed: ' + err.message });
  } finally {
    busy = false;
    busySince = null;
    busyMode = null;
  }
});

// ── Static assets ────────────────────────────────────────────────────────────

app.get('/logo.jpg', (req, res) => {
  res.sendFile('logo.jpg', { root: import.meta.dirname || '.' });
});

// ── Site Proxy (cache-busting) ────────────────────────────────────────────────

app.get('/preview', async (req, res) => {
  try {
    const targetUrl = req.query.path ? `${WP_SITE}${req.query.path}` : WP_SITE;
    // Add a unique query param to bust server-side page cache
    const bustUrl = targetUrl + (targetUrl.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    const response = await fetch(bustUrl, {
      headers: { 
        'Cache-Control': 'no-cache, no-store', 
        'Pragma': 'no-cache',
        // Pretend to be a regular browser so WP doesn't serve a different version
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    let html = await response.text();
    // Rewrite absolute URLs to load assets directly from WP site
    html = html.replace(new RegExp(WP_SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), WP_SITE);
    res.set({
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(html);
  } catch (err) {
    res.status(502).send('Failed to load site preview');
  }
});

// ── Demo Page ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawPress Build</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a1a; }
  
  /* Top bar */
  #topbar {
    position: fixed; top: 0; left: 0; right: 0; height: 48px; z-index: 100;
    background: #1a1a2e; border-bottom: 1px solid #2a2a4a;
    display: flex; align-items: center; padding: 0 20px; gap: 12px;
  }
  #topbar .logo { width: 28px; height: 28px; border-radius: 50%; }
  #topbar .title { color: #e0e0e0; font-weight: 600; font-size: 15px; }
  #topbar .subtitle { color: #888; font-size: 13px; }
  #topbar .powered { margin-left: auto; color: #555; font-size: 12px; }
  #topbar .powered a { color: #e94560; text-decoration: none; }
  
  /* Viewport toggle */
  #viewport-toggle {
    display: flex; gap: 4px; margin-left: 12px;
  }
  #viewport-toggle button {
    background: none; border: 1px solid #2a2a4a; border-radius: 6px; color: #888;
    padding: 4px 10px; cursor: pointer; font-size: 12px; transition: all 0.2s;
  }
  #viewport-toggle button:hover { border-color: #e94560; color: #e94560; }
  #viewport-toggle button.active { border-color: #e94560; color: #e94560; background: rgba(233,69,96,0.1); }
  
  /* Site iframe */
  #site-frame {
    position: fixed; top: 48px; left: 0; right: 0; bottom: 0;
    border: none; width: 100%; height: calc(100vh - 48px);
    transition: all 0.3s ease;
  }
  #site-frame.mobile-view {
    width: 375px; left: 50%; right: auto;
    transform: translateX(-50%);
    border-left: 1px solid #2a2a4a; border-right: 1px solid #2a2a4a;
  }
  #site-frame.tablet-view {
    width: 768px; left: 50%; right: auto;
    transform: translateX(-50%);
    border-left: 1px solid #2a2a4a; border-right: 1px solid #2a2a4a;
  }
  
  /* Chat widget */
  #cp-pg-toggle {
    position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px;
    background: #1a1a2e; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 28px; cursor: pointer; z-index: 99999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3); transition: transform 0.2s;
    border: 2px solid #2a2a4a;
  }
  #cp-pg-toggle:hover { transform: scale(1.1); }
  #cp-pg-panel {
    display: none; position: fixed; bottom: 92px; right: 24px; width: 400px;
    max-height: 560px; background: #1a1a2e; border-radius: 16px; z-index: 99999;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4); flex-direction: column; overflow: hidden;
    border: 1px solid #2a2a4a;
  }
  #cp-pg-panel.open { display: flex; }
  #cp-pg-header {
    padding: 14px 16px; background: #16213e; color: #e0e0e0; display: flex;
    justify-content: space-between; align-items: center; font-weight: 600;
  }
  #cp-pg-close { background: none; border: none; color: #e0e0e0; font-size: 20px; cursor: pointer; }
  #cp-pg-messages {
    flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column;
    gap: 12px; max-height: 380px;
  }
  .cp-pg-msg {
    padding: 10px 14px; border-radius: 12px; line-height: 1.5; max-width: 90%;
    word-wrap: break-word; font-size: 14px;
  }
  .cp-pg-msg em { font-style: italic; opacity: 0.85; }
  .cp-pg-bot { background: #16213e; color: #e0e0e0; align-self: flex-start; }
  .cp-pg-user { background: #e94560; color: #fff; align-self: flex-end; }
  .cp-pg-building { background: #16213e; color: #888; align-self: flex-start; font-style: italic; }
  #cp-pg-input-wrap {
    padding: 12px; display: flex; gap: 8px; border-top: 1px solid #2a2a4a;
  }
  #cp-pg-input {
    flex: 1; background: #16213e; border: 1px solid #2a2a4a; border-radius: 8px;
    color: #e0e0e0; padding: 8px 12px; resize: none; font-family: inherit; font-size: 14px;
  }
  #cp-pg-input::placeholder { color: #666; }
  #cp-pg-send {
    background: #e94560; color: #fff; border: none; border-radius: 8px;
    padding: 8px 16px; cursor: pointer; font-weight: 600; font-size: 14px;
    white-space: nowrap;
  }
  #cp-pg-send:hover { background: #c73e54; }
  #cp-pg-send:disabled { opacity: 0.5; cursor: not-allowed; }
  #cp-pg-status { padding: 0 12px 8px; color: #666; font-size: 12px; text-align: center; }
  #cp-pg-reset-wrap { padding: 4px 12px 10px; text-align: center; }
  #cp-pg-reset {
    background: none; border: 1px solid #333; border-radius: 6px; color: #888;
    padding: 4px 12px; cursor: pointer; font-size: 11px; transition: all 0.2s;
  }
  #cp-pg-reset:hover { border-color: #e94560; color: #e94560; }
  #cp-pg-reset:disabled { opacity: 0.4; cursor: not-allowed; }
  @keyframes cp-dots { 0%,80%,100% { opacity:.3; } 40% { opacity:1; } }
  .cp-dots span { animation: cp-dots 1.4s infinite; }
  .cp-dots span:nth-child(2) { animation-delay: .2s; }
  .cp-dots span:nth-child(3) { animation-delay: .4s; }
</style>
</head>
<body>
  <div id="topbar">
    <img class="logo" src="/logo.jpg" alt="ClawPress">
    <span class="title">ClawPress Build</span>
    <span class="subtitle">Describe it. We'll build it.</span>
    <div id="viewport-toggle">
      <button class="active" data-view="desktop" title="Desktop view">🖥</button>
      <button data-view="tablet" title="Tablet view">📱</button>
      <button data-view="mobile" title="Mobile view">📲</button>
    </div>
    <span class="powered">Powered by <a href="https://clawpress.blog">ClawPress</a></span>
  </div>
  
  <div id="build-banner" style="display:none; position:fixed; top:0; left:0; right:0; z-index:99998;
    background:#1a1a2e; color:#fff; text-align:center; padding:10px 16px 0;
    font-weight:600; font-size:14px; letter-spacing:0.5px; border-bottom:1px solid #2a2a4a;">
    <div id="banner-text">Building site... watch the magic happen</div>
    <div id="banner-progress" style="width:100%; height:4px; background:#2a2a4a; margin-top:8px; border-radius:2px; overflow:hidden;">
      <div id="banner-bar" style="height:100%; width:0%; background:linear-gradient(90deg,#e94560,#ff6b6b); transition:width 0.5s ease; border-radius:2px;"></div>
    </div>
  </div>
  <iframe id="site-frame" src="/preview"></iframe>
  
  <div id="cp-pg-toggle" title="Build this site with AI"><img src="/logo.jpg" style="width:36px;height:36px;border-radius:50%;" alt="ClawPress"></div>
  <div id="cp-pg-panel">
    <div id="cp-pg-header">
      <span><img src="/logo.jpg" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px;" alt="">ClawPress Build</span>
      <button id="cp-pg-close">&times;</button>
    </div>
    <div id="cp-pg-messages">
      <div class="cp-pg-msg cp-pg-bot">
        Tell me what kind of site to build! Try: <em>"Build me a mobile BBQ restaurant site — food truck in Colorado Springs. Make it modern and not look like a regular WordPress site."</em>
      </div>
    </div>
    <div id="cp-pg-input-wrap">
      <textarea id="cp-pg-input" placeholder="Describe the site you want to build..." rows="2"></textarea>
      <button id="cp-pg-send">🚀 Build</button>
    </div>
    <div id="cp-pg-status"></div>
    <div id="cp-pg-reset-wrap">
      <button id="cp-pg-reset" title="Wipe the site and start fresh">🧹 Reset Site</button>
    </div>
  </div>
  
  <script>
  (function() {
    // Live build: SSE connection for real-time updates
    let currentBuildId = null;
    function connectSSE() {
      const evtSource = new EventSource('/events');
      evtSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'mutation') {
            const frame = document.getElementById('site-frame');
            frame.src = frame.src.split('?')[0] + '?nocache=' + Date.now();
          }
          if (data.type === 'build-complete') {
            // Build finished — show reply in chat
            const buildingMsgs = document.querySelectorAll('.cp-pg-building');
            buildingMsgs.forEach(m => m.remove());
            if (data.reply) {
              addMsg(data.reply, 'cp-pg-bot');
              history.push({ role: 'assistant', content: data.reply });
            }
            sendBtn.disabled = false;
            sendBtn.textContent = '🚀 Build';
            status.textContent = '✅ Site updated! The preview has been refreshed.';
            const frame = document.getElementById('site-frame');
            frame.src = frame.src.split('?')[0] + '?nocache=' + Date.now();
          }
          if (data.type === 'build-error') {
            const buildingMsgs = document.querySelectorAll('.cp-pg-building');
            buildingMsgs.forEach(m => m.remove());
            addMsg(data.error || 'Build failed. Try again!', 'cp-pg-bot');
            sendBtn.disabled = false;
            sendBtn.textContent = '🚀 Build';
            status.textContent = '';
          }
        } catch (err) {}
      };
      evtSource.onerror = () => {
        // SSE auto-reconnects — nothing to do
      };
      return evtSource;
    }
    connectSSE();

    // Viewport toggle
    document.querySelectorAll('#viewport-toggle button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#viewport-toggle button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const frame = document.getElementById('site-frame');
        frame.classList.remove('mobile-view', 'tablet-view');
        if (btn.dataset.view === 'mobile') frame.classList.add('mobile-view');
        else if (btn.dataset.view === 'tablet') frame.classList.add('tablet-view');
      });
    });

    const toggle = document.getElementById('cp-pg-toggle');
    const panel = document.getElementById('cp-pg-panel');
    const closeBtn = document.getElementById('cp-pg-close');
    const messagesEl = document.getElementById('cp-pg-messages');
    const input = document.getElementById('cp-pg-input');
    const sendBtn = document.getElementById('cp-pg-send');
    const status = document.getElementById('cp-pg-status');
    const siteFrame = document.getElementById('site-frame');

    toggle.addEventListener('click', () => panel.classList.toggle('open'));
    closeBtn.addEventListener('click', () => panel.classList.remove('open'));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    sendBtn.addEventListener('click', send);
    
    // Auto-open the panel
    setTimeout(() => panel.classList.add('open'), 1000);

    const history = [];
    const resetBtn = document.getElementById('cp-pg-reset');
    
    resetBtn.addEventListener('click', async () => {
      if (!confirm('This will wipe the entire site and start fresh. Continue?')) return;
      resetBtn.disabled = true;
      resetBtn.textContent = '🧹 Resetting...';
      status.textContent = 'Wiping site...';
      try {
        const res = await fetch('/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        if (data.ok) {
          // Clear chat history
          history.length = 0;
          messagesEl.innerHTML = '<div class="cp-pg-msg cp-pg-bot">Site wiped clean! Tell me what to build next.</div>';
          siteFrame.src = siteFrame.src.split('?')[0] + '?nocache=' + Date.now();
          status.textContent = '✅ Ready for a new build.';
          setTimeout(() => { if (status.textContent.includes('Ready')) status.textContent = ''; }, 3000);
        } else {
          status.textContent = '❌ ' + (data.error || 'Reset failed');
        }
      } catch (err) {
        status.textContent = '❌ Lost connection — try again in a sec';
      }
      resetBtn.disabled = false;
      resetBtn.textContent = '🧹 Reset Site';
    });

    function addMsg(text, cls) {
      const div = document.createElement('div');
      div.className = 'cp-pg-msg ' + cls;
      if (cls === 'cp-pg-building') {
        div.innerHTML = text;
      } else {
        div.textContent = text;
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;

      addMsg(text, 'cp-pg-user');
      input.value = '';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Building...';

      addMsg(
        'Building your site <span class="cp-dots"><span>.</span><span>.</span><span>.</span></span> watch the preview update in real time',
        'cp-pg-building'
      );

      history.push({ role: 'user', content: text });

      try {
        const res = await fetch('/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history })
        });
        const data = await res.json();

        if (data.error) {
          const buildingMsgs = document.querySelectorAll('.cp-pg-building');
          buildingMsgs.forEach(m => m.remove());
          addMsg('Error: ' + data.error, 'cp-pg-bot');
          sendBtn.disabled = false;
          sendBtn.textContent = '🚀 Build';
          status.textContent = '';
        } else {
          // Build started successfully — SSE will handle completion
          currentBuildId = data.buildId;
          status.textContent = 'Build submitted — watching progress...';
        }
      } catch (err) {
        const buildingMsgs = document.querySelectorAll('.cp-pg-building');
        buildingMsgs.forEach(m => m.remove());
        const errDiv = document.createElement('div');
        errDiv.className = 'cp-pg-msg cp-pg-bot';
        errDiv.innerHTML = 'Hmm, couldn\\'t reach the server. <button onclick="this.parentElement.remove(); send();" style="background:#e94560; color:#fff; border:none; border-radius:6px; padding:4px 12px; cursor:pointer; font-size:13px; margin-left:6px;">🔄 Try Again</button>';
        messagesEl.appendChild(errDiv);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        sendBtn.disabled = false;
        sendBtn.textContent = '🚀 Build';
        status.textContent = '';
      }
    }

    // Poll build status — shows banner even in other browser windows
    const banner = document.getElementById('build-banner');
    let wasBusy = false;
    setInterval(async () => {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const bannerText = document.getElementById('banner-text');
        const bannerBar = document.getElementById('banner-bar');
        const bannerProgress = document.getElementById('banner-progress');
        if (data.busy) {
          banner.style.display = 'block';
          if (data.mode === 'resetting') {
            bannerText.textContent = '🧹 Sweeping... clearing the slate';
            bannerProgress.style.display = 'none';
          } else {
            const pct = data.maxIterations ? Math.min(95, (data.iteration / data.maxIterations) * 100) : 0;
            const label = data.toolLabel || 'WordPressing...';
            bannerText.textContent = label;
            bannerBar.style.width = pct + '%';
            bannerProgress.style.display = 'block';
          }
          wasBusy = true;
        } else {
          if (wasBusy) {
            if (data.lastCompletedMode === 'resetting') {
              bannerText.textContent = '🧹 Site wiped!';
            } else {
              bannerText.textContent = '✅ Build complete!';
            }
            bannerBar.style.width = '100%';
            siteFrame.src = siteFrame.src.split("?")[0] + "?nocache=" + Date.now();
            setTimeout(() => { banner.style.display = 'none'; wasBusy = false; }, 3000);
          } else {
            banner.style.display = 'none';
          }
        }
      } catch (e) {}
    }, 2000);
  })();
  </script>
</body>
</html>`);
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🦞 ClawPress Build Relay running on port ${PORT}`);
  console.log(`   Site: ${WP_SITE}`);
  console.log(`   User: ${WP_USER}`);
});
