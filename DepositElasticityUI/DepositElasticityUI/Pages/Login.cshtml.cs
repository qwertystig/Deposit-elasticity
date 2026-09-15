using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace DepositElasticity.Pages
{
    public class LoginModel : PageModel
    {
        [BindProperty]
        public string Email { get; set; } = "";

        [BindProperty]
        public string Password { get; set; } = "";

        public string? ErrorMessage { get; set; }

        public void OnGet()
        {
        }

        public IActionResult OnPost()
        {
            // TODO: replace with real auth (Barclays SSO / Azure AD) before anything
            // beyond the POC. This just gates the demo behind a login screen.
            if (string.IsNullOrWhiteSpace(Email) || string.IsNullOrWhiteSpace(Password))
            {
                ErrorMessage = "Enter your work email and password to continue.";
                return Page();
            }

            HttpContext.Session.SetString("Email", Email);
            return RedirectToPage("/Chat");
        }
    }
}
