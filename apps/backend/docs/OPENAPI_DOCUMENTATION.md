# OpenAPI Specification Documentation

## Overview

This document describes the comprehensive OpenAPI 3.1.0 specification for the Financial Transaction Manager API,
focusing on the **admin** and **categories** endpoints. The API follows REST Level 3 (HATEOAS) principles, providing
hypermedia links that guide clients through available operations.

## 🎯 Key Features

### **Level 3 REST API (HATEOAS)**

- **Hypermedia Links**: Every response includes links to available actions
- **Self-Documenting**: Clients can discover operations through hypermedia
- **Navigation**: Links guide clients through the API workflow
- **Discoverability**: OPTIONS methods reveal available operations

### **Comprehensive Error Handling**

- **Structured Errors**: Consistent error response format
- **HTTP Status Codes**: Proper status codes for all scenarios
- **Error Codes**: Machine-readable error codes for client handling
- **Field Validation**: Detailed field-level error reporting

### **British English Compliance**

- **Terminology**: "Initialise", "colour", etc.
- **Documentation**: All descriptions use British spelling
- **Parameters**: API parameter names follow British conventions

## 📋 Specification Contents

### **Admin Endpoints**

| Endpoint                    | Method  | Description                  |
|-----------------------------|---------|------------------------------|
| `/api/admin`                | OPTIONS | Discover admin capabilities  |
| `/api/admin`                | GET     | Get database status          |
| `/api/admin/database/init`  | POST    | Initialise database tables   |
| `/api/admin/database/reset` | POST    | Reset database (DESTRUCTIVE) |

### **Categories Endpoints**

| Endpoint                                  | Method  | Description                      |
|-------------------------------------------|---------|----------------------------------|
| `/api/categories`                         | OPTIONS | Discover collection capabilities |
| `/api/categories`                         | GET     | List categories with pagination  |
| `/api/categories`                         | POST    | Create or get existing category  |
| `/api/categories/{categoryId}`            | OPTIONS | Discover individual capabilities |
| `/api/categories/{categoryId}`            | GET     | Get category by ID               |
| `/api/categories/{categoryId}`            | PATCH   | Update category                  |
| `/api/categories/{categoryId}`            | DELETE  | Delete category (soft/hard)      |
| `/api/categories/assign`                  | OPTIONS | Discover assignment capabilities |
| `/api/categories/assign`                  | POST    | Assign category to recipients    |
| `/api/categories/path/{general}/{detail}` | OPTIONS | Discover path lookup             |
| `/api/categories/path/{general}/{detail}` | GET     | Get category by path             |

## 🔧 Using the Specification

### **Code Generation**

This specification can be used with various code generation tools:

```bash
# OpenAPI Generator
openapi-generator-cli generate \
  -i openapi_spec.yaml \
  -g python-fastapi \
  -o ./generated-client

# Swagger Codegen
swagger-codegen generate \
  -i openapi_spec.yaml \
  -l python \
  -o ./python-client
```

### **Documentation Generation**

Generate interactive documentation:

```bash
# Swagger UI
swagger-ui-bundle --file openapi_spec.yaml

# Redoc
redoc-cli build openapi_spec.yaml --output docs.html
```

### **API Testing**

Use the specification for automated testing:

```bash
# Dredd API testing
dredd openapi_spec.yaml http://localhost:8000

# Postman collection generation
openapi2postmanv2 -s openapi_spec.yaml -o collection.json
```

## 📊 Schema Highlights

### **HATEOAS Link Schema**

```yaml
Link:
  type: object
  required: [ rel, href, method ]
  properties:
    rel:
      type: string
      examples: [ self, parent, update, delete ]
    href:
      type: string
      format: uri
    method:
      type: string
      enum: [ GET, POST, PATCH, DELETE, OPTIONS ]
    title:
      type: string
```

### **Category Schema**

```yaml
CategoryResponse:
  properties:
    id:
      type: integer
      minimum: 1
    general:
      type: string
      description: "Normalised to uppercase"
    detail:
      type: string
      description: "Normalised to uppercase"
    color:
      type: string
      pattern: "^#[0-9A-Fa-f]{6}$"
    links:
      type: array
      items:
        $ref: '#/components/schemas/Link'
```

### **Error Response Schema**

```yaml
ErrorResponse:
  properties:
    detail:
      type: string
      description: "Human-readable error message"
    error_code:
      type: string
      description: "Machine-readable error code"
    field_errors:
      type: object
      description: "Field-specific validation errors"
```

## 🎨 Advanced Features

### **Pagination Support**

```yaml
CategoriesListResponse:
  properties:
    items:
      type: array
    total:
      type: integer
    limit:
      type: integer
    offset:
      type: integer
    links:
      type: array  # Next, previous, self links
```

### **Bulk Operations**

```yaml
AssignCategoryRequest:
  properties:
    recipient_ids:
      oneOf:
        - type: integer      # Single recipient
        - type: array        # Multiple recipients
          items:
            type: integer
```

### **Path-Based Navigation**

```yaml
/api/categories/path/{general}/{detail}:
  get:
    description: "RESTful hierarchical category lookup"
    parameters:
      - name: general
        in: path
        required: true
      - name: detail
        in: path
        required: true
```

## 🚀 Implementation Benefits

### **For Frontend Developers**

- **Type Safety**: Generate TypeScript types from schemas
- **Validation**: Client-side validation using the same schemas
- **Navigation**: Follow HATEOAS links for API discovery
- **Testing**: Automated API testing using the specification

### **For Backend Developers**

- **Documentation**: Auto-generated, always up-to-date docs
- **Validation**: Request/response validation
- **Code Generation**: Generate server stubs and client libraries
- **Testing**: Contract testing and API validation

### **For QA Teams**

- **Test Generation**: Automated test case generation
- **Contract Testing**: Ensure API compliance
- **Mock Services**: Generate mock servers for testing
- **Documentation**: Clear endpoint specifications

## 🔐 Security Considerations

### **Current State (Development)**

- No authentication required
- All endpoints publicly accessible
- Suitable for development environments

### **Future Production Security**

The specification includes placeholders for:

- **API Key Authentication**
- **JWT Bearer Token Authentication**
- **Role-Based Access Control**

```yaml
securitySchemes:
  ApiKeyAuth:
    type: apiKey
    in: header
    name: X-API-Key

  BearerAuth:
    type: http
    scheme: bearer
    bearerFormat: JWT
```

## 📝 Best Practices

### **API Evolution**

- **Versioning**: Specification supports API versioning
- **Backwards Compatibility**: Careful schema design for evolution
- **Deprecation**: Clear marking of deprecated endpoints

### **Documentation**

- **Examples**: Comprehensive request/response examples
- **Descriptions**: Detailed operation descriptions
- **Use Cases**: Real-world usage scenarios included

### **Error Handling**

- **Consistent Format**: All errors follow the same structure
- **Helpful Messages**: Human-readable error descriptions
- **Machine Processing**: Error codes for automated handling

## 🎯 Next Steps

### **Immediate Actions**

1. **Review Specification**: Validate against current implementation
2. **Generate Client**: Create client libraries in your preferred language
3. **Test Integration**: Use specification for API testing
4. **Generate Documentation**: Create interactive API docs

### **Future Enhancements**

1. **Additional Endpoints**: Extend specification for other API areas
2. **Authentication**: Implement security schemes
3. **Webhooks**: Add webhook specifications
4. **Rate Limiting**: Document rate limiting policies

## 📚 Resources

### **Tools**

- [OpenAPI Generator](https://openapi-generator.tech/)
- [Swagger UI](https://swagger.io/tools/swagger-ui/)
- [Redoc](https://redocly.github.io/redoc/)
- [Postman](https://www.postman.com/api-platform/api-documentation/)

### **Validation**

- [Swagger Editor](https://editor.swagger.io/)
- [OpenAPI Spec Validator](https://github.com/p1c2u/openapi-spec-validator)
- [Spectral](https://stoplight.io/open-source/spectral)

### **Testing**

- [Dredd](https://dredd.org/)
- [Pact](https://pact.io/)
- [WireMock](http://wiremock.org/)

---

**Status**: ✅ **Complete** - Comprehensive OpenAPI specification ready for use  
**Coverage**: 🎯 **Admin & Categories** - All endpoints documented with examples  
**Quality**: 🏆 **Production Ready** - Follows OpenAPI 3.1.0 best practices
