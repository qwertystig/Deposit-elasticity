using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using DepositElasticity.Models;
using DepositElasticity.Services;

namespace DepositElasticity.Controllers
{
    [ApiController]
    [Route("api/conversation")]
    public class ConversationController : ControllerBase
    {
        private readonly IConversationAgentService _conversation;
        private readonly IConfiguration _config;
        private readonly ILogger<ConversationController> _logger;
        private readonly SessionStore _sessions;

        public ConversationController(
            IConversationAgentService conversation,
            IConfiguration config,
            ILogger<ConversationController> logger,
            SessionStore sessions)
        {
            _conversation = conversation;
            _config = config;
            _logger = logger;
            _sessions = sessions;
        }

        // ── Session key helpers ──────────────────────────────────────────────
        private string ConvIdKey(string slotKey) => $"Conv_{slotKey}_Id";
        private string HistoryKey(string slotKey) => $"Conv_{slotKey}_History";
        private string FileIdKey(string slotKey) => $"Conv_{slotKey}_FileId";
        private string GeneratedFilesKey(string slotKey) => $"Conv_{slotKey}_GeneratedFiles";

        private string ResolveAssetId(string slotKey)
        {
            var assetId = _config[$"PurpleFabric:Agents:{slotKey}"];
            if (string.IsNullOrEmpty(assetId))
                throw new ArgumentException($"Unknown conversation slot '{slotKey}' — no asset ID configured.");
            return assetId;
        }

        private List<ConversationMessage> LoadHistory(string slotKey)
        {
            var raw = HttpContext.Session.GetString(HistoryKey(slotKey));
            if (string.IsNullOrEmpty(raw)) return new List<ConversationMessage>();
            try { return JsonConvert.DeserializeObject<List<ConversationMessage>>(raw) ?? new(); }
            catch { return new(); }
        }

        private void SaveHistory(string slotKey, List<ConversationMessage> history)
            => HttpContext.Session.SetString(HistoryKey(slotKey), JsonConvert.SerializeObject(history));

        // ── GET history/{slotKey} ────────────────────────────────────────────
        [HttpGet("history/{slotKey}")]
        public IActionResult GetHistory(string slotKey)
        {
            try
            {
                return Ok(new ConversationHistoryResponse { Messages = LoadHistory(slotKey) });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[ConversationController] GetHistory failed for slot {SlotKey}", slotKey);
                return StatusCode(500, new { error = ex.Message });
            }
        }

        // ── POST send/{slotKey}  (legacy sync — kept for backwards compat) ───
        [HttpPost("send/{slotKey}")]
        [RequestSizeLimit(50_000_000)]
        public async Task<IActionResult> Send(string slotKey, [FromForm] string? query, IFormFile? file)
        {
            _logger.LogInformation("[ConversationController] Send called — slot: {SlotKey}, hasFile: {HasFile}", slotKey, file != null);

            if (string.IsNullOrWhiteSpace(query) && file == null)
                return BadRequest(new { error = "Please provide a message or attach a file." });

            try
            {
                var assetId = ResolveAssetId(slotKey);
                var history = LoadHistory(slotKey);

                var convId = HttpContext.Session.GetString(ConvIdKey(slotKey));
                if (string.IsNullOrEmpty(convId))
                {
                    convId = await _conversation.CreateConversationAsync(assetId);
                    HttpContext.Session.SetString(ConvIdKey(slotKey), convId);
                    _logger.LogInformation("[ConversationController] Created conversation {ConvId} for slot {SlotKey}", convId, slotKey);
                }

                history.Add(new ConversationMessage { Role = "user", Text = query ?? "", FileName = file?.FileName });

                string reply;
                List<GeneratedFile> files = new();

                if (file != null)
                {
                    var previousFileId = HttpContext.Session.GetString(FileIdKey(slotKey));
                    var result = await _conversation.SendMessageWithAttachmentAsync(convId, query ?? "", file, previousFileId);
                    reply = result.Reply;
                    if (!string.IsNullOrEmpty(result.FileId))
                        HttpContext.Session.SetString(FileIdKey(slotKey), result.FileId);
                }
                else
                {
                    var (replyText, messageId, sendFiles) = await _conversation.SendMessageAsync(convId, query ?? "");
                    reply = replyText;
                    files = sendFiles;

                    if (files.Count > 0)
                    {
                        HttpContext.Session.SetString(GeneratedFilesKey(slotKey), JsonConvert.SerializeObject(
                            files.Select(f => new { f.FileName, f.MimeType, MessageId = messageId, f.MessageContentId })
                        ));
                    }
                }

                history.Add(new ConversationMessage { Role = "agent", Text = reply });
                SaveHistory(slotKey, history);

                return Ok(new ConversationSendResponse
                {
                    Success = true,
                    Reply = reply,
                    Files = files.Select(f => new GeneratedFileInfo { FileName = f.FileName }).ToList()
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[ConversationController] Send failed for slot {SlotKey}", slotKey);
                return StatusCode(500, new ConversationSendResponse { Success = false, Error = ex.Message });
            }
        }

        // ── POST send-async/{slotKey} ────────────────────────────────────────
        [HttpPost("send-async/{slotKey}")]
        [RequestSizeLimit(50_000_000)]
        public async Task<IActionResult> SendAsync(string slotKey, [FromForm] string? query, [FromForm] string? sessionId, IFormFile? file)
        {
            _logger.LogInformation("[ConversationController] SendAsync called — slot: {SlotKey}, session: {SessionId}, query: '{Query}', hasFile: {HasFile}",
                slotKey, sessionId, query, file != null);

            // FIX: a plain text query with no file is perfectly valid for all conversation
            // agents (execed, universityassistant, etc.). The previous guard was correct in
            // intent but the JS had query commented out, so both were null. Now that JS sends
            // query correctly, this guard only blocks truly empty requests (no text AND no file).
            if (string.IsNullOrWhiteSpace(query) && file == null)
                return BadRequest(new { error = "Please provide a message or attach a file." });

            try
            {
                var assetId = ResolveAssetId(slotKey);
                var userEmail = HttpContext.Session.GetString("Email");

                string? convId;
                string? resolvedSessionId = null;

                if (!string.IsNullOrEmpty(sessionId) && !string.IsNullOrEmpty(userEmail))
                {
                    // Multi-session path: the session (and its Purple Fabric conversation_id,
                    // once created) lives in SQLite via SessionStore, not ASP.NET Session — that's
                    // what lets a user come back to an older analysis after their browser session
                    // itself has expired.
                    var chatSession = _sessions.GetSession(sessionId, userEmail);
                    if (chatSession == null)
                        return NotFound(new { error = "Session not found." });

                    resolvedSessionId = sessionId;
                    convId = chatSession.ConversationId;
                    if (string.IsNullOrEmpty(convId))
                    {
                        convId = await _conversation.CreateConversationAsync(assetId);
                        _sessions.SetConversationId(sessionId, convId);
                        _logger.LogInformation("[ConversationController] Created new conversation {ConvId} for session {SessionId}",
                            convId, sessionId);
                    }
                    else
                    {
                        _logger.LogInformation("[ConversationController] Reusing conversation {ConvId} for session {SessionId}",
                            convId, sessionId);
                    }

                    if (!string.IsNullOrWhiteSpace(query))
                    {
                        _sessions.AddMessage(sessionId, "user", query);
                        _sessions.SetTitleIfUnset(sessionId, query);
                        _sessions.Touch(sessionId);
                    }
                }
                else
                {
                    // Legacy path (no sessionId supplied) — unchanged single-conversation-per-
                    // slot behavior, kept so any older caller still works.
                    convId = HttpContext.Session.GetString(ConvIdKey(slotKey));
                    if (string.IsNullOrEmpty(convId))
                    {
                        convId = await _conversation.CreateConversationAsync(assetId);
                        HttpContext.Session.SetString(ConvIdKey(slotKey), convId);
                        _logger.LogInformation("[ConversationController] Created new conversation {ConvId} for slot {SlotKey}",
                            convId, slotKey);
                    }
                    else
                    {
                        _logger.LogInformation("[ConversationController] Reusing conversation {ConvId} for slot {SlotKey}",
                            convId, slotKey);
                    }
                }

                byte[]? fileBytes = null;
                string? fileName = null;
                string? contentType = null;
                if (file != null)
                {
                    using var ms = new MemoryStream();
                    await file.CopyToAsync(ms);
                    fileBytes = ms.ToArray();
                    fileName = file.FileName;
                    contentType = file.ContentType;
                }

                var history = LoadHistory(slotKey);
                history.Add(new ConversationMessage { Role = "user", Text = query ?? "", FileName = fileName });
                SaveHistory(slotKey, history);

                var previousFileId = HttpContext.Session.GetString(FileIdKey(slotKey));
                var traceId = Guid.NewGuid().ToString();

                if (resolvedSessionId != null)
                    HttpContext.Session.SetString($"Trace_{traceId}_SessionId", resolvedSessionId);

                _conversation.StartBackgroundSend(
                    traceId, convId, query ?? "",
                    fileBytes, fileName, contentType, previousFileId);

                return Ok(new { traceId });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[ConversationController] SendAsync failed for slot {SlotKey}", slotKey);
                return StatusCode(500, new { error = ex.Message });
            }
        }

        // ── GET send-status/{slotKey}/{traceId} ──────────────────────────────
        [HttpGet("send-status/{slotKey}/{traceId}")]
        public IActionResult GetSendStatus(string slotKey, string traceId)
        {
            try
            {
                var status = _conversation.GetJobStatus(traceId);
                if (status == null)
                    return Ok(new { status = "PENDING" });

                List<object>? filesForResponse = null;

                if (status.Status == "COMPLETED")
                {
                    var history = LoadHistory(slotKey);
                    history.Add(new ConversationMessage { Role = "agent", Text = status.Reply ?? "" });
                    SaveHistory(slotKey, history);

                    // Multi-session persistence — guarded so a repeated poll after COMPLETED
                    // (e.g. the client re-checking after a refresh) never double-inserts.
                    var mappedSessionId = HttpContext.Session.GetString($"Trace_{traceId}_SessionId");
                    if (!string.IsNullOrEmpty(mappedSessionId) &&
                        HttpContext.Session.GetString($"Trace_{traceId}_Persisted") == null)
                    {
                        _sessions.AddMessage(mappedSessionId, "agent", status.Reply ?? "");
                        _sessions.Touch(mappedSessionId);
                        HttpContext.Session.SetString($"Trace_{traceId}_Persisted", "1");
                    }

                    if (!string.IsNullOrEmpty(status.NewFileId))
                        HttpContext.Session.SetString(FileIdKey(slotKey), status.NewFileId);

                    if (status.Files != null && status.Files.Count > 0 && !string.IsNullOrEmpty(status.MessageId))
                    {
                        HttpContext.Session.SetString(GeneratedFilesKey(slotKey), JsonConvert.SerializeObject(
                            status.Files.Select(f => new
                            {
                                f.FileName,
                                f.MimeType,
                                MessageId = status.MessageId,
                                f.MessageContentId
                            })
                        ));

                        filesForResponse = status.Files
                            .Select(f => (object)new { fileName = f.FileName })
                            .ToList();
                    }
                }

                return Ok(new
                {
                    status = status.Status,
                    reply = status.Reply,
                    error = status.Error,
                    files = filesForResponse,
                    selectedTools = status.SelectedTools,
                    notificationSteps = status.NotificationSteps,
                    traces = status.Traces,
                    sources = status.Sources,
                    citation = status.Citation
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "[ConversationController] GetSendStatus failed for slot {SlotKey}, trace {TraceId}",
                    slotKey, traceId);
                return StatusCode(500, new { error = ex.Message });
            }
        }

        // ── POST upload/{slotKey} ────────────────────────────────────────────
        [HttpPost("upload/{slotKey}")]
        [RequestSizeLimit(50_000_000)]
        public async Task<IActionResult> UploadOnly(string slotKey, IFormFile file)
        {
            if (file == null) return BadRequest(new { success = false, error = "No file provided." });

            try
            {
                var assetId = ResolveAssetId(slotKey);
                var convId = HttpContext.Session.GetString(ConvIdKey(slotKey));
                if (string.IsNullOrEmpty(convId))
                {
                    convId = await _conversation.CreateConversationAsync(assetId);
                    HttpContext.Session.SetString(ConvIdKey(slotKey), convId);
                }

                var previousFileId = HttpContext.Session.GetString(FileIdKey(slotKey));
                if (!string.IsNullOrEmpty(previousFileId))
                    await _conversation.DeleteFileAsync(convId, previousFileId);

                var (_, fileId, uploadStatus) = await _conversation.UploadFileAsync(convId, file);
                HttpContext.Session.SetString(FileIdKey(slotKey), fileId);

                return Ok(new { success = true, fileId, status = uploadStatus });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[ConversationController] UploadOnly failed for slot {SlotKey}", slotKey);
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        // ── GET file-status/{slotKey}/{fileId} ───────────────────────────────
        [HttpGet("file-status/{slotKey}/{fileId}")]
        public IActionResult FileStatus(string slotKey, string fileId)
            => Ok(new { ready = true });

        // ── GET download/{slotKey}/{fileName} ────────────────────────────────
        [HttpGet("download/{slotKey}/{fileName}")]
        public async Task<IActionResult> DownloadFile(string slotKey, string fileName)
        {
            try
            {
                var convId = HttpContext.Session.GetString(ConvIdKey(slotKey));
                var raw = HttpContext.Session.GetString(GeneratedFilesKey(slotKey));

                if (string.IsNullOrEmpty(convId) || string.IsNullOrEmpty(raw))
                {
                    _logger.LogWarning("[ConversationController] DownloadFile — no session data for slot {SlotKey}, file {FileName}",
                        slotKey, fileName);
                    return NotFound(new { error = "No generated file found for this session." });
                }

                var files = JsonConvert.DeserializeObject<List<dynamic>>(raw);
                var match = files?.FirstOrDefault(f => (string)f.FileName == fileName);
                if (match == null)
                {
                    _logger.LogWarning("[ConversationController] DownloadFile — '{FileName}' not found in session files for slot {SlotKey}",
                        fileName, slotKey);
                    return NotFound(new { error = $"File '{fileName}' not found in this session." });
                }

                string messageId = (string)match.MessageId;
                string messageContentId = (string)match.MessageContentId;

                _logger.LogInformation(
                    "[ConversationController] Downloading '{FileName}' — convId={ConvId}, msgId={MsgId}, contentId={ContentId}",
                    fileName, convId, messageId, messageContentId);

                var bytes = await _conversation.DownloadGeneratedFileAsync(
                    convId, messageId, messageContentId, fileName);

                var contentType = fileName.EndsWith(".docx", StringComparison.OrdinalIgnoreCase)
                    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    : fileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)
                        ? "application/pdf"
                        : "application/octet-stream";

                return File(bytes, contentType, fileName);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "[ConversationController] DownloadFile failed for slot {SlotKey}, file {FileName}",
                    slotKey, fileName);
                return StatusCode(500, new { error = ex.Message });
            }
        }

        // ── GET dms-document ─────────────────────────────────────────────────
        [HttpGet("dms-document")]
        public async Task<IActionResult> GetDmsDocument([FromQuery] string docDataId)
        {
            if (string.IsNullOrWhiteSpace(docDataId))
                return BadRequest(new { error = "docDataId is required." });

            try
            {
                var (bytes, contentType, fileName) = await _conversation.FetchDmsDocumentAsync(docDataId);
                return File(bytes, contentType, fileName);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "[ConversationController] GetDmsDocument failed for docDataId {DocDataId}", docDataId);
                return StatusCode(500, new { error = ex.Message });
            }
        }

        // ── POST reset/{slotKey} ─────────────────────────────────────────────
        [HttpPost("reset/{slotKey}")]
        public IActionResult Reset(string slotKey)
        {
            HttpContext.Session.Remove(ConvIdKey(slotKey));
            HttpContext.Session.Remove(HistoryKey(slotKey));
            HttpContext.Session.Remove(FileIdKey(slotKey));
            HttpContext.Session.Remove(GeneratedFilesKey(slotKey));
            return Ok(new { success = true });
        }
    }
}