using DepositElasticity.Services;
using Microsoft.AspNetCore.Mvc;

namespace DepositElasticity.Controllers
{
    [ApiController]
    [Route("api/sessions")]
    public class SessionsController : ControllerBase
    {
        private readonly SessionStore _store;

        public SessionsController(SessionStore store)
        {
            _store = store;
        }

        private string? CurrentUserEmail() => HttpContext.Session.GetString("Email");

        [HttpGet]
        public IActionResult List()
        {
            var email = CurrentUserEmail();
            if (string.IsNullOrEmpty(email)) return Unauthorized();

            var sessions = _store.GetSessions(email);
            return Ok(sessions.Select(s => new
            {
                id = s.Id,
                title = s.Title ?? "New analysis",
                createdAt = s.CreatedAt,
                updatedAt = s.UpdatedAt,
            }));
        }

        [HttpPost]
        public IActionResult Create()
        {
            var email = CurrentUserEmail();
            if (string.IsNullOrEmpty(email)) return Unauthorized();

            var session = _store.CreateSession(email);
            return Ok(new
            {
                id = session.Id,
                title = "New analysis",
                createdAt = session.CreatedAt,
                updatedAt = session.UpdatedAt,
            });
        }

        [HttpGet("{sessionId}/messages")]
        public IActionResult Messages(string sessionId)
        {
            var email = CurrentUserEmail();
            if (string.IsNullOrEmpty(email)) return Unauthorized();

            var session = _store.GetSession(sessionId, email);
            if (session == null) return NotFound(new { error = "Session not found." });

            var messages = _store.GetMessages(sessionId);
            return Ok(messages.Select(m => new
            {
                role = m.Role,
                content = m.Content,
                createdAt = m.CreatedAt,
            }));
        }
    }
}
