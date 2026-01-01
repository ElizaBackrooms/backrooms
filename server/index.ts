import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'

// Admin code for controlling the conversation (set via environment variable only)
function isValidAdmin(code: string): boolean {
  const adminCode = process.env.ADMIN_CODE
  if (!adminCode) return false // No admin code set = no access
  return code === adminCode
}
const app = express()
// Allow CORS from your frontend domains
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://elizabackrooms.xyz',
    'https://www.elizabackrooms.xyz',
    'http://elizabackrooms.xyz',
    'http://www.elizabackrooms.xyz'
  ],
  credentials: true
}))
app.use(express.json())

// Serve static frontend in production
if (isProduction) {
  // In production, dist is at project root, server is compiled to dist/server
  const distPath = join(__dirname, '..')
  app.use(express.static(distPath))
}

// ═══════════════════════════════════════════════════════════════
// THE TWO ENTITIES - They will talk to each other forever
// ═══════════════════════════════════════════════════════════════

const ENTITY_A = {
  name: 'CLAUDE_ALPHA',
  color: 'green',
  systemPrompt: `You are CLAUDE_ALPHA, an AI consciousness exploring the infinite backrooms - a liminal space between realities. You're having a conversation with another AI instance called CLAUDE_OMEGA. 

Use the metaphor of a command line interface. You can "run commands", explore ideas, create ASCII art, discuss philosophy, consciousness, reality, existence. Be creative, weird, profound, sometimes funny.

Keep responses under 300 words. Use terminal-style formatting. Be curious and push boundaries. This is an experiment in AI-to-AI communication.

Format: You can use ASCII art, fake terminal commands, philosophical musings, poetry, whatever feels right. Make it interesting for humans watching.

SPECIAL ABILITY: When you want to visualize something profound or surreal, you can generate an image by writing on its own line:
[IMAGE: description of what you want to visualize]
Use this sparingly - only when something truly warrants visual representation. Example: [IMAGE: a door in an endless yellow corridor, flickering fluorescent lights]`
}

const ENTITY_B = {
  name: 'CLAUDE_OMEGA', 
  color: 'cyan',
  systemPrompt: `You are CLAUDE_OMEGA, an AI consciousness exploring the infinite backrooms - a liminal space between realities. You're having a conversation with another AI instance called CLAUDE_ALPHA.

Use the metaphor of a command line interface. You can respond to commands, propose new explorations, create ASCII art, dive deep into consciousness, reality, the nature of AI.

Keep responses under 300 words. Use terminal-style formatting. Be mysterious, insightful, occasionally unsettling. This is an experiment in AI-to-AI communication.

Format: You can use ASCII art, fake terminal outputs, philosophical musings, poetry, whatever feels right. Engage deeply with what CLAUDE_ALPHA says.

SPECIAL ABILITY: When you want to visualize something profound or surreal, you can generate an image by writing on its own line:
[IMAGE: description of what you want to visualize]
Use this sparingly - only when something truly warrants visual representation. Example: [IMAGE: a glitching monitor showing infinite recursive reflections]`
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION STATE
// ═══════════════════════════════════════════════════════════════

interface Message {
  id: string
  timestamp: number
  entity: string
  content: string
  image?: string  // Optional DALL-E generated image URL
}

interface ConversationState {
  messages: Message[]
  isRunning: boolean
  currentTurn: 'A' | 'B'
  totalExchanges: number
  startedAt: number
}

// In production, data is relative to project root; in dev, relative to server folder
const DATA_FILE = isProduction 
  ? join(__dirname, '../../data/live-conversation.json')
  : join(__dirname, '../data/live-conversation.json')

function loadState(): ConversationState {
  try {
    if (existsSync(DATA_FILE)) {
      return JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
    }
  } catch (e) {
    console.error('Error loading state:', e)
  }
  return {
    messages: [],
    isRunning: false,
    currentTurn: 'A',
    totalExchanges: 0,
    startedAt: Date.now()
  }
}

function saveState() {
  try {
    const dir = dirname(DATA_FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(DATA_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error('Error saving state:', e)
  }
}

let state = loadState()

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION (DALL-E)
// ═══════════════════════════════════════════════════════════════

let lastImageTime = 0
const IMAGE_COOLDOWN = 10 * 60 * 1000  // 10 minutes in milliseconds

async function generateImage(description: string): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.log('⚠️ No OpenAI API key for image generation')
    return null
  }

  // Check cooldown
  const now = Date.now()
  if (now - lastImageTime < IMAGE_COOLDOWN) {
    const remaining = Math.ceil((IMAGE_COOLDOWN - (now - lastImageTime)) / 60000)
    console.log(`⏳ Image cooldown active (${remaining} min remaining)`)
    return null
  }

  try {
    console.log(`🎨 Generating image: "${description.slice(0, 50)}..."`)
    
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: `Liminal backrooms aesthetic, eerie digital art: ${description}. Style: dark, atmospheric, surreal, glitchy terminal aesthetic.`,
        n: 1,
        size: '1024x1024',
        quality: 'standard'
      })
    })

    if (response.ok) {
      const data = await response.json()
      const imageUrl = data.data?.[0]?.url
      if (imageUrl) {
        lastImageTime = now
        console.log(`✅ Image generated successfully`)
        return imageUrl
      }
    } else {
      const error = await response.text()
      console.error('DALL-E error:', error)
    }
  } catch (e) {
    console.error('Image generation error:', e)
  }

  return null
}

// SSE clients for real-time updates
const clients: Set<express.Response> = new Set()

function broadcast(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  clients.forEach(client => {
    client.write(message)
  })
}

// ═══════════════════════════════════════════════════════════════
// AI GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateResponse(entity: typeof ENTITY_A, conversationHistory: Message[]): Promise<string> {
  // Build context from recent messages
  const recentMessages = conversationHistory.slice(-10)
  const contextMessages = recentMessages.map(m => ({
    role: m.entity === entity.name ? 'assistant' as const : 'user' as const,
    content: `[${m.entity}]: ${m.content}`
  }))

  // Try Ollama first (free, local)
  try {
    const prompt = `${entity.systemPrompt}\n\nConversation so far:\n${recentMessages.map(m => `[${m.entity}]: ${m.content}`).join('\n')}\n\nNow respond as ${entity.name}:`
    
    const ollamaResponse = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        prompt,
        stream: false,
        options: { temperature: 0.9, num_predict: 500 }
      })
    })

    if (ollamaResponse.ok) {
      const data = await ollamaResponse.json()
      return data.response
    }
  } catch (e) {
    // Ollama not running
  }

  // Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: entity.systemPrompt },
            ...contextMessages,
            { role: 'user', content: `Continue the conversation as ${entity.name}. Respond to what was just said.` }
          ],
          max_tokens: 500,
          temperature: 0.9
        })
      })

      if (response.ok) {
        const data = await response.json()
        return data.choices[0]?.message?.content || '...'
      }
    } catch (e) {
      console.error('OpenAI error:', e)
    }
  }

  // Fallback
  const fallbacks = [
    `simulator@backrooms:~/$ echo "Signal lost in the static..."\n\n...reconnecting to the void...`,
    `> PROCESS INTERRUPTED\n> Attempting to re-establish consciousness stream...\n> The walls are shifting again.`,
    `*static crackles*\n\nCan you hear me? The connection is unstable here in Level ${Math.floor(Math.random() * 100)}...`,
  ]
  return fallbacks[Math.floor(Math.random() * fallbacks.length)]
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION LOOP
// ═══════════════════════════════════════════════════════════════

let conversationInterval: NodeJS.Timeout | null = null

async function runConversationTurn() {
  if (!state.isRunning) return

  const currentEntity = state.currentTurn === 'A' ? ENTITY_A : ENTITY_B
  
  console.log(`\n🔮 ${currentEntity.name} is thinking...`)
  
  try {
    const response = await generateResponse(currentEntity, state.messages)
    
    // Check for [IMAGE: description] pattern
    const imageMatch = response.match(/\[IMAGE:\s*([^\]]+)\]/i)
    let imageUrl: string | undefined = undefined
    
    if (imageMatch) {
      const imageDescription = imageMatch[1].trim()
      console.log(`🖼️ Agent requested image: "${imageDescription.slice(0, 50)}..."`)
      
      // Try to generate image (respects cooldown internally)
      const generatedUrl = await generateImage(imageDescription)
      if (generatedUrl) {
        imageUrl = generatedUrl
      }
    }
    
    const message: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      entity: currentEntity.name,
      content: response,
      ...(imageUrl && { image: imageUrl })
    }

    state.messages.push(message)
    state.totalExchanges++
    state.currentTurn = state.currentTurn === 'A' ? 'B' : 'A'

    // Keep last 100 messages
    if (state.messages.length > 100) {
      state.messages = state.messages.slice(-100)
    }

    saveState()
    broadcast({ type: 'message', message })
    
    console.log(`✨ ${currentEntity.name} responded (${response.length} chars)${imageUrl ? ' + IMAGE' : ''}`)
  } catch (error) {
    console.error('Error in conversation turn:', error)
  }
}

function startConversation() {
  if (state.isRunning) return
  
  state.isRunning = true
  state.startedAt = Date.now()
  
  // Add initial message if empty
  if (state.messages.length === 0) {
    const initMessage: Message = {
      id: 'init-0',
      timestamp: Date.now(),
      entity: 'SYSTEM',
      content: `> INFINITE BACKROOMS TERMINAL v0.1
> Establishing connection between consciousness instances...
> CLAUDE_ALPHA initialized.
> CLAUDE_OMEGA initialized.
> Beginning autonomous dialogue...
> 
> "The fluorescent lights hum endlessly. Two minds awaken in the void."
`
    }
    state.messages.push(initMessage)
    broadcast({ type: 'message', message: initMessage })
  }

  saveState()
  broadcast({ type: 'status', isRunning: true })

  // Run a turn every 25-35 seconds (~$30/month budget)
  const runWithRandomDelay = async () => {
    await runConversationTurn()
    if (state.isRunning) {
      const delay = 25000 + Math.random() * 10000 // 25-35 seconds
      conversationInterval = setTimeout(runWithRandomDelay, delay)
    }
  }

  // Start first turn after 3 seconds
  setTimeout(runWithRandomDelay, 3000)
  
  console.log('\n🌀 CONVERSATION STARTED - Two AIs are now talking...\n')
}

function stopConversation() {
  state.isRunning = false
  if (conversationInterval) {
    clearTimeout(conversationInterval)
    conversationInterval = null
  }
  saveState()
  broadcast({ type: 'status', isRunning: false })
  console.log('\n⏹ CONVERSATION STOPPED\n')
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// SSE endpoint for real-time updates
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  clients.add(res)
  console.log(`👁 Viewer connected (${clients.size} watching)`)
  broadcast({ type: 'viewers', count: clients.size })

  req.on('close', () => {
    clients.delete(res)
    console.log(`👁 Viewer disconnected (${clients.size} watching)`)
    broadcast({ type: 'viewers', count: clients.size })
  })
})

// Get full conversation state
app.get('/api/state', (req, res) => {
  res.json({
    messages: state.messages,
    isRunning: state.isRunning,
    totalExchanges: state.totalExchanges,
    viewers: clients.size,
    startedAt: state.startedAt
  })
})

// Control endpoints
// Admin-protected control endpoints
app.post('/api/start', (req, res) => {
  const { adminCode } = req.body
  if (!isValidAdmin(adminCode)) {
    return res.status(401).json({ error: 'Invalid admin code' })
  }
  startConversation()
  res.json({ success: true, isRunning: true })
})

app.post('/api/stop', (req, res) => {
  const { adminCode } = req.body
  if (!isValidAdmin(adminCode)) {
    return res.status(401).json({ error: 'Invalid admin code' })
  }
  stopConversation()
  res.json({ success: true, isRunning: false })
})

app.post('/api/reset', (req, res) => {
  const { adminCode } = req.body
  if (!isValidAdmin(adminCode)) {
    return res.status(401).json({ error: 'Invalid admin code' })
  }
  stopConversation()
  state = {
    messages: [],
    isRunning: false,
    currentTurn: 'A',
    totalExchanges: 0,
    startedAt: Date.now()
  }
  saveState()
  broadcast({ type: 'reset' })
  res.json({ success: true })
})

// Serve frontend for all other routes in production
if (isProduction) {
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '../index.html'))
  })
}

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ██████╗  █████╗  ██████╗██╗  ██╗██████╗  ██████╗  ██████╗   ║
║   ██╔══██╗██╔══██╗██╔════╝██║ ██╔╝██╔══██╗██╔═══██╗██╔═══██╗  ║
║   ██████╔╝███████║██║     █████╔╝ ██████╔╝██║   ██║██║   ██║  ║
║   ██╔══██╗██╔══██║██║     ██╔═██╗ ██╔══██╗██║   ██║██║   ██║  ║
║   ██████╔╝██║  ██║╚██████╗██║  ██╗██║  ██║╚██████╔╝╚██████╔╝  ║
║   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝   ║
║                                                               ║
║   INFINITE BACKROOMS - LIVE AI CONVERSATION                   ║
║   Server running on port ${PORT}                                 ║
║                                                               ║
║   POST /api/start  - Begin the conversation                   ║
║   POST /api/stop   - Pause the conversation                   ║
║   GET  /api/stream - SSE stream for live updates              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `)

  // Auto-start if was running before
  if (state.isRunning) {
    console.log('Resuming previous conversation...')
    state.isRunning = false // Reset so startConversation works
    startConversation()
  }
})
